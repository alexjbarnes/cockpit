// `claude mcp` is the CLI's own account-level machinery: the list health-checks
// every server it knows about, and signing in is an interactive flow that only
// a PTY can carry. These pin the parsing, the environment the commands run in,
// and the two shapes a sign-in takes.
import { beforeEach, describe, expect, it, vi } from "vitest";

let execFileResult: { err: Error | null; stdout: string; stderr: string } = { err: null, stdout: "", stderr: "" };
let execFileCalls: { args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }[] = [];

vi.mock("node:child_process", () => {
  const record = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    execFileCalls.push({ args, cwd: opts?.cwd, env: opts?.env });
    // Node hangs the output off the error when the command fails, which is what
    // the module's error path reads.
    if (execFileResult.err) {
      Object.assign(execFileResult.err, { stdout: execFileResult.stdout, stderr: execFileResult.stderr });
    }
    return execFileResult;
  };
  const execFile = (
    _cmd: string,
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv },
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const result = record(args, opts);
    cb(result.err, result.stdout, result.stderr);
  };
  // The module promisifies execFile. Without this symbol promisify falls back to
  // resolving with stdout alone rather than {stdout, stderr}.
  Object.assign(execFile, {
    [Symbol.for("nodejs.util.promisify.custom")]: async (_cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      const result = record(args, opts);
      if (result.err) throw result.err;
      return { stdout: result.stdout, stderr: result.stderr };
    },
  });
  return { execFile };
});

vi.mock("@/server/claude-bin", () => ({ getClaudeBin: () => "claude" }));

type DataHandler = (chunk: string) => void;
type ExitHandler = (info: { exitCode: number }) => void;
let dataHandler: DataHandler | null = null;
let exitHandler: ExitHandler | null = null;

const mockPty = {
  write: vi.fn(),
  onData: vi.fn((cb: DataHandler) => {
    dataHandler = cb;
  }),
  onExit: vi.fn((cb: ExitHandler) => {
    exitHandler = cb;
  }),
  kill: vi.fn(),
  pid: 11,
};

vi.mock("node-pty", () => ({ spawn: vi.fn(() => mockPty) }));

import { spawn } from "node-pty";
import {
  cancelLogin,
  claudeMcpEnv,
  clearMcpServerCache,
  extractLoginUrl,
  listClaudeMcpServers,
  logoutMcpServer,
  parseMcpList,
  startMcpLogin,
  stripAnsi,
  submitLoginRedirect,
} from "@/server/mcp-auth";

/** What `claude mcp list` prints on a machine with connectors and local servers. */
const LIST_OUTPUT = `⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set

Checking MCP server health…

claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected
claude.ai Todoist: https://ai.todoist.net/mcp - ! Needs authentication
plugin:graphene:graphene: node /home/dev/.claude/plugins/cache/graphene/dist/index.js - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed
gmail: npx -y @gongrzhe/server-gmail-autoauth-mcp - ✔ Connected
conduit: http://100.77.12.68:8080/mcp (HTTP) - ✔ Connected
project-server: node server.js - ⏸ Pending approval
`;

describe("parseMcpList", () => {
  it("reads each server's name, target, scope and status", () => {
    expect(parseMcpList(LIST_OUTPUT)).toEqual([
      { name: "claude.ai Claude Docs", target: "https://api.anthropic.com/v1/pages/mcp", scope: "connector", status: "connected" },
      {
        name: "claude.ai Todoist",
        target: "https://ai.todoist.net/mcp",
        scope: "connector",
        status: "needs-auth",
      },
      {
        name: "plugin:graphene:graphene",
        target: "node /home/dev/.claude/plugins/cache/graphene/dist/index.js",
        scope: "local",
        status: "failed",
        detail: "CONNECTION_CLOSED: Connection closed",
      },
      {
        name: "gmail",
        target: "npx -y @gongrzhe/server-gmail-autoauth-mcp",
        scope: "local",
        status: "connected",
      },
      { name: "conduit", target: "http://100.77.12.68:8080/mcp (HTTP)", scope: "local", status: "connected" },
      { name: "project-server", target: "node server.js", scope: "local", status: "pending" },
    ]);
  });

  it("skips the banner and the connector warning", () => {
    expect(parseMcpList(LIST_OUTPUT).some((s) => s.name.includes("Checking"))).toBe(false);
  });

  it("ignores output that is not a server line", () => {
    expect(parseMcpList("No MCP servers configured.\n")).toEqual([]);
  });
});

describe("claudeMcpEnv", () => {
  it("drops provider auth, which otherwise stops the CLI loading account connectors", () => {
    const env = claudeMcpEnv({
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      ANTHROPIC_AUTH_TOKEN: "token",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1/proxy",
      HOME: "/home/dev",
    });

    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/dev" });
  });

  it("keeps everything else, so the CLI still finds its config and credentials", () => {
    expect(claudeMcpEnv({ CLAUDE_CONFIG_DIR: "/tmp/cfg" })).toEqual({ CLAUDE_CONFIG_DIR: "/tmp/cfg" });
  });
});

describe("stripAnsi", () => {
  it("removes the colour and hyperlink codes the CLI prints around a URL", () => {
    const coloured = "\x1b[0m\x1b[31mNo MCP server named \x1b]8;;https://x\x07link\x1b]8;;\x07";
    expect(stripAnsi(coloured)).toBe("No MCP server named link");
  });
});

describe("extractLoginUrl", () => {
  it("takes a connector's authorisation URL", () => {
    expect(extractLoginUrl("Visit this URL to authorize:\r\n  https://claude.ai/api/organizations/x/mcp/start-auth/y\r\n")).toEqual({
      kind: "connector",
      url: "https://claude.ai/api/organizations/x/mcp/start-auth/y",
    });
  });

  it("takes a server's own authorisation URL and knows it needs the redirect back", () => {
    expect(extractLoginUrl("Authorization URL:   https://mcp.example.com/authorize?state=1\n")).toEqual({
      kind: "redirect",
      url: "https://mcp.example.com/authorize?state=1",
    });
  });

  it("finds nothing in output that has no URL yet", () => {
    expect(extractLoginUrl("Checking configuration...\n")).toBeNull();
  });
});

describe("listClaudeMcpServers", () => {
  beforeEach(() => {
    clearMcpServerCache();
    execFileCalls = [];
    execFileResult = { err: null, stdout: LIST_OUTPUT, stderr: "" };
  });

  it("runs the CLI's own list and returns what it reported", async () => {
    const list = await listClaudeMcpServers({ cwd: "/work/repo" });

    expect(execFileCalls[0].args).toEqual(["mcp", "list"]);
    expect(execFileCalls[0].cwd).toBe("/work/repo");
    expect(execFileCalls[0].env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(list.servers).toHaveLength(6);
  });

  it("answers a second look from the cache, since the list health-checks every server", async () => {
    await listClaudeMcpServers();
    await listClaudeMcpServers();

    expect(execFileCalls).toHaveLength(1);
  });

  it("health-checks again when asked to refresh", async () => {
    await listClaudeMcpServers();
    await listClaudeMcpServers({ force: true });

    expect(execFileCalls).toHaveLength(2);
  });

  it("reports a failure that produced nothing to parse", async () => {
    execFileResult = { err: new Error("exit 1"), stdout: "", stderr: "claude is not installed" };

    await expect(listClaudeMcpServers()).rejects.toThrow("claude is not installed");
  });

  it("still lists the servers when a failure came with output", async () => {
    execFileResult = { err: new Error("exit 1"), stdout: LIST_OUTPUT, stderr: "" };

    await expect(listClaudeMcpServers()).resolves.toMatchObject({ servers: expect.any(Array) });
  });
});

describe("logoutMcpServer", () => {
  beforeEach(() => {
    clearMcpServerCache();
    execFileCalls = [];
    execFileResult = { err: null, stdout: "Cleared stored OAuth credentials\n", stderr: "" };
  });

  it("runs the CLI's logout", async () => {
    await expect(logoutMcpServer("conduit")).resolves.toMatchObject({ ok: true });
    expect(execFileCalls[0].args).toEqual(["mcp", "logout", "conduit"]);
  });

  it("reports what the CLI said when it refuses", async () => {
    execFileResult = { err: new Error("exit 1"), stdout: "", stderr: 'No MCP server named "nope".' };

    await expect(logoutMcpServer("nope")).resolves.toEqual({ ok: false, stdout: "", stderr: 'No MCP server named "nope".' });
  });
});

describe("startMcpLogin", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.mocked(spawn).mockClear();
    mockPty.write.mockClear();
    mockPty.kill.mockClear();
    dataHandler = null;
    exitHandler = null;
    clearMcpServerCache();
  });

  it("returns the URL a connector prints and lets the process go", async () => {
    const started = startMcpLogin("claude.ai Todoist");
    dataHandler?.("Visit this URL to authorize:\r\n  https://claude.ai/api/organizations/x/mcp/start-auth/y\r\n");

    await expect(started).resolves.toEqual({
      ok: true,
      kind: "connector",
      name: "claude.ai Todoist",
      url: "https://claude.ai/api/organizations/x/mcp/start-auth/y",
    });
    expect(mockPty.kill).toHaveBeenCalled();
  });

  it("keeps a server's own sign-in open for the redirect URL", async () => {
    const started = startMcpLogin("conduit");
    dataHandler?.(`Authorization URL:   https://mcp.example.com/authorize\nOr paste the redirect URL here: `);
    const outcome = await started;

    expect(outcome).toMatchObject({ ok: true, kind: "redirect", name: "conduit", url: "https://mcp.example.com/authorize" });
    if (!outcome.ok || outcome.kind !== "redirect") throw new Error("expected a redirect sign-in");

    const submitted = submitLoginRedirect(outcome.id, "http://localhost:7777/callback");
    expect(mockPty.write).toHaveBeenCalledWith("http://localhost:7777/callback\r");
    exitHandler?.({ exitCode: 0 });
    await expect(submitted).resolves.toEqual({ ok: true });
  });

  it("reports the CLI's own refusal", async () => {
    const started = startMcpLogin("nope");
    dataHandler?.('No MCP server named "nope". Configured servers: conduit, gmail\n');

    await expect(started).resolves.toMatchObject({ ok: false, error: expect.stringContaining("No MCP server named") });
  });

  it("reports a process that ends without printing a URL", async () => {
    const started = startMcpLogin("conduit");
    exitHandler?.({ exitCode: 1 });

    await expect(started).resolves.toMatchObject({ ok: false });
  });

  it("gives up when no URL arrives", async () => {
    vi.useFakeTimers();
    const started = startMcpLogin("conduit");
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(started).resolves.toMatchObject({ ok: false, error: expect.stringContaining("authorisation URL") });
    expect(mockPty.kill).toHaveBeenCalled();
  });

  it("reports a CLI that could not be started at all", async () => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error("spawn claude ENOENT");
    });

    await expect(startMcpLogin("conduit")).resolves.toEqual({ ok: false, error: "spawn claude ENOENT" });
  });

  it("refuses a redirect URL for a sign-in that is not waiting", async () => {
    await expect(submitLoginRedirect("nothing", "http://localhost:1/cb")).resolves.toMatchObject({ ok: false });
  });

  it("reports a redirect the CLI would not accept", async () => {
    const started = startMcpLogin("conduit");
    dataHandler?.("Authorization URL:   https://mcp.example.com/authorize\n");
    const outcome = await started;
    if (!outcome.ok || outcome.kind !== "redirect") throw new Error("expected a redirect sign-in");

    const submitted = submitLoginRedirect(outcome.id, "not-a-url");
    exitHandler?.({ exitCode: 1 });
    await expect(submitted).resolves.toMatchObject({ ok: false });
  });

  it("drops a sign-in that is abandoned", async () => {
    const started = startMcpLogin("conduit");
    dataHandler?.("Authorization URL:   https://mcp.example.com/authorize\n");
    const outcome = await started;
    if (!outcome.ok || outcome.kind !== "redirect") throw new Error("expected a redirect sign-in");

    expect(cancelLogin(outcome.id)).toBe(true);
    expect(cancelLogin(outcome.id)).toBe(false);
    expect(mockPty.kill).toHaveBeenCalled();
  });
});
