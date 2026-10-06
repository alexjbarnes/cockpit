import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { type IPty, spawn } from "node-pty";
import { getClaudeBin } from "@/server/claude-bin";

const execFileAsync = promisify(execFile);

// `mcp list` health-checks every configured server, and a stdio one can take
// seconds to answer, so this shares the plugin commands' ceiling.
const MCP_CMD_TIMEOUT_MS = 120_000;
const MCP_CMD_MAX_BUFFER = 4 * 1024 * 1024;
// The page reads this on open; a second look at the same page should not pay
// for a second health-check of every server.
const LIST_CACHE_MS = 60_000;
// How long the CLI is given to print an authorisation URL before giving up.
const LOGIN_URL_TIMEOUT_MS = 30_000;
// A login waiting for the redirect URL holds a PTY open; let it go after this.
const LOGIN_PENDING_TIMEOUT_MS = 5 * 60_000;
// How long the CLI is given to finish once the redirect URL has been pasted.
const LOGIN_SUBMIT_TIMEOUT_MS = 60_000;

/**
 * Auth in the environment takes precedence over the claude.ai login, and the
 * CLI then refuses to load account connectors at all ("claude.ai connectors are
 * disabled because ANTHROPIC_API_KEY or another auth source is set"). Every
 * command here is about the account's own servers, so the provider wiring is
 * dropped before the CLI is started.
 */
const STRIPPED_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];

/** The environment a `claude mcp` command runs in: the account's, not a provider's. */
export function claudeMcpEnv(base: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  // Spreading a plain record loses the project's required NODE_ENV declaration,
  // which this only ever carries over from the environment it was given.
  const env = { ...base } as NodeJS.ProcessEnv;
  for (const key of STRIPPED_ENV) delete env[key];
  return env;
}

export type McpServerStatus = "connected" | "needs-auth" | "pending" | "failed";
export type McpServerScope = "connector" | "local";

export interface McpServerEntry {
  /** The name the CLI knows the server by, which is what `login` takes. */
  name: string;
  /** The command or URL the CLI printed for it. */
  target: string;
  /** Account connectors are named "claude.ai <name>"; everything else is local. */
  scope: McpServerScope;
  status: McpServerStatus;
  detail?: string;
}

export interface McpCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run `claude mcp <args...>` non-interactively, reporting failure rather than throwing. */
export async function runClaudeMcp(args: string[], cwd?: string): Promise<McpCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(getClaudeBin(), ["mcp", ...args], {
      encoding: "utf-8",
      timeout: MCP_CMD_TIMEOUT_MS,
      maxBuffer: MCP_CMD_MAX_BUFFER,
      cwd,
      env: claudeMcpEnv(),
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr || e.message || "mcp command failed" };
  }
}

const STATUS_MARKERS: Record<string, McpServerStatus> = {
  "✔": "connected",
  "!": "needs-auth",
  "⏸": "pending",
  "✘": "failed",
};

// The name is greedy so a name that itself contains a colon (the CLI lists
// installed plugin servers as "plugin:graphene:graphene") still splits at the
// last one before the target.
const LIST_LINE = /^(?<name>.+): (?<target>.+) - (?<marker>[✔!⏸✘])\s*(?<detail>.*)$/;
const FAILED_PREFIX = /^Failed to connect\s*(—|-)?\s*/;

/**
 * Parse `claude mcp list`. Each server is one line:
 *   claude.ai Todoist: https://ai.todoist.net/mcp - ! Needs authentication
 *   gmail: npx -y @gongrzhe/server-gmail-autoauth-mcp - ✔ Connected
 * Anything that is not such a line (the health-check banner, the warning that
 * connectors are disabled) is skipped.
 */
export function parseMcpList(stdout: string): McpServerEntry[] {
  const servers: McpServerEntry[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const match = LIST_LINE.exec(line);
    if (!match?.groups) continue;
    const { name, target, marker } = match.groups as { name: string; target: string; marker: string; detail: string };
    const status = STATUS_MARKERS[marker];
    if (!status) continue;
    // Past the marker the line only repeats the status, except for a failure,
    // where the CLI puts the reason there.
    const detail = status === "failed" ? (match.groups.detail || "").replace(FAILED_PREFIX, "").trim() : "";
    const entry: McpServerEntry = {
      name,
      target,
      scope: name.startsWith("claude.ai ") ? "connector" : "local",
      status,
    };
    if (detail) entry.detail = detail;
    servers.push(entry);
  }
  return servers;
}

export interface McpServerList {
  servers: McpServerEntry[];
  /** When the list was produced, for the page's "last checked" line. */
  checkedAt: number;
}

let listCache: McpServerList | null = null;

/** Every server the CLI knows about, account connectors included. Cached briefly. */
export async function listClaudeMcpServers(options: { cwd?: string; force?: boolean } = {}): Promise<McpServerList> {
  if (!options.force && listCache && Date.now() - listCache.checkedAt < LIST_CACHE_MS) return listCache;
  const res = await runClaudeMcp(["list"], options.cwd);
  // A non-zero exit still prints the servers it managed to reach; only treat it
  // as a failure when there is nothing to parse.
  const servers = parseMcpList(res.stdout);
  if (!res.ok && servers.length === 0) throw new Error(res.stderr || "claude mcp list failed");
  listCache = { servers, checkedAt: Date.now() };
  return listCache;
}

/** Drop the cached list, so the next read health-checks again. */
export function clearMcpServerCache(): void {
  listCache = null;
}

// OSC hyperlink sequences and CSI colour/cursor codes, which are what the login
// process emits. The control characters are the point of the pattern.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes requires matching them
const ANSI = /\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[a-zA-Z]/g;

/** The TUI paints in colour and moves the cursor; match against plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** The two shapes of authorisation URL the CLI prints, and what each means. */
export interface LoginUrl {
  kind: "connector" | "redirect";
  url: string;
}

const CONNECTOR_URL = /Visit this URL to authorize:\s*\n?\s*(\S+)/;
const REDIRECT_URL = /Authorization URL:\s*\n?\s*(\S+)/;
// The CLI's own failure lines, so a dead end is reported as one.
const LOGIN_FAILURE = /No MCP server named|Couldn't complete authentication|Invalid authorization URL/;

/** Read the authorisation URL out of what the login process has printed so far. */
export function extractLoginUrl(buffer: string): LoginUrl | null {
  const connector = CONNECTOR_URL.exec(buffer);
  if (connector) return { kind: "connector", url: connector[1] };
  const redirect = REDIRECT_URL.exec(buffer);
  if (redirect) return { kind: "redirect", url: redirect[1] };
  return null;
}

export type LoginOutcome =
  | { ok: true; kind: "connector"; name: string; url: string }
  | { ok: true; kind: "redirect"; name: string; id: string; url: string }
  | { ok: false; error: string };

interface PendingLogin {
  name: string;
  pty: IPty;
  output: string;
  /** Resolves with the CLI's exit code once the process is gone. */
  exit: Promise<number>;
  timer: NodeJS.Timeout;
}

// A redirect login stays alive between the two requests that drive it, keyed by
// an id the page passes back with the pasted URL.
const pendingLogins = new Map<string, PendingLogin>();

/**
 * Start `claude mcp login <name> --no-browser` in a PTY. A claude.ai connector
 * prints one URL and exits; a server that speaks OAuth prints its own
 * authorisation URL and waits for the redirect URL to be typed back, which
 * needs a TTY, so the process is kept for submitLoginRedirect.
 */
export async function startMcpLogin(name: string, cwd?: string): Promise<LoginOutcome> {
  let ptyProc: IPty;
  try {
    ptyProc = spawn(getClaudeBin(), ["mcp", "login", name, "--no-browser"], {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd,
      env: claudeMcpEnv() as Record<string, string>,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not start the CLI" };
  }

  return new Promise<LoginOutcome>((resolve) => {
    let settled = false;
    let output = "";
    const exit = new Promise<number>((done) => ptyProc.onExit(({ exitCode }) => done(exitCode)));
    const finish = (outcome: LoginOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(urlTimer);
      resolve(outcome);
    };

    const urlTimer = setTimeout(() => {
      finish({ ok: false, error: tailOf(output) || "The CLI did not print an authorisation URL." });
      ptyProc.kill();
    }, LOGIN_URL_TIMEOUT_MS);

    ptyProc.onData((data) => {
      output += stripAnsi(data);
      if (LOGIN_FAILURE.test(output)) {
        finish({ ok: false, error: tailOf(output) });
        ptyProc.kill();
        return;
      }
      const found = extractLoginUrl(output);
      if (!found) return;
      if (found.kind === "connector") {
        // Nothing more is needed from the process: the rest happens on claude.ai.
        finish({ ok: true, kind: "connector", name, url: found.url });
        ptyProc.kill();
        return;
      }
      const id = randomBytes(8).toString("hex");
      const timer = setTimeout(() => {
        pendingLogins.delete(id);
        ptyProc.kill();
      }, LOGIN_PENDING_TIMEOUT_MS);
      pendingLogins.set(id, { name, pty: ptyProc, output, exit, timer });
      finish({ ok: true, kind: "redirect", name, id, url: found.url });
    });

    void exit.then((code) => {
      if (settled) return;
      finish({ ok: false, error: tailOf(output) || `claude mcp login exited with code ${code}` });
    });
  });
}

/** Feed the redirect URL the browser sent back into the waiting login. */
export async function submitLoginRedirect(id: string, redirectUrl: string): Promise<{ ok: boolean; error?: string }> {
  const entry = pendingLogins.get(id);
  if (!entry) return { ok: false, error: "That sign-in is no longer waiting for a redirect URL." };

  entry.pty.write(`${redirectUrl}\r`);
  const code = await Promise.race([entry.exit, timeout(LOGIN_SUBMIT_TIMEOUT_MS)]);
  clearTimeout(entry.timer);
  pendingLogins.delete(id);
  entry.pty.kill();

  if (code === null) return { ok: false, error: "Timed out waiting for the CLI to finish." };
  if (code !== 0) return { ok: false, error: tailOf(entry.output) || `claude mcp login exited with code ${code}` };
  clearMcpServerCache();
  return { ok: true };
}

/** Abandon a login that is still waiting for its redirect URL. */
export function cancelLogin(id: string): boolean {
  const entry = pendingLogins.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingLogins.delete(id);
  entry.pty.kill();
  return true;
}

/** Clear the credentials the CLI holds for a server. */
export async function logoutMcpServer(name: string, cwd?: string): Promise<McpCommandResult> {
  const res = await runClaudeMcp(["logout", name], cwd);
  if (res.ok) clearMcpServerCache();
  return res;
}

function timeout(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

/** The last few lines the CLI printed, for an error message a person can read. */
function tailOf(output: string): string {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join("\n");
}
