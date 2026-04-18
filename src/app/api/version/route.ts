import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, readFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

type InstallMethod = "npm" | "bun" | "brew" | "mise" | "volta" | "pnpm" | "yarn" | "fnm" | "nvm" | "binary";

const UPDATE_COMMANDS: Record<InstallMethod, string> = {
  npm: "npm install -g @anthropic-ai/claude-code",
  bun: "bun install -g @anthropic-ai/claude-code",
  brew: "brew upgrade claude",
  mise: "mise upgrade claude",
  volta: "volta install @anthropic-ai/claude-code",
  pnpm: "pnpm add -g @anthropic-ai/claude-code",
  yarn: "yarn global add @anthropic-ai/claude-code",
  fnm: "npm install -g @anthropic-ai/claude-code",
  nvm: "npm install -g @anthropic-ai/claude-code",
  binary: "Download from https://claude.ai/code",
};

async function detectInstallMethod(): Promise<InstallMethod> {
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync(whichCmd, ["claude"], { timeout: 3000 });
    const whichPath = stdout.trim();
    const resolved = await realpath(whichPath).catch(() => whichPath);
    const combined = `${whichPath}\n${resolved}`.toLowerCase();

    if (combined.includes("/brew/") || combined.includes("/cellar/") || combined.includes("/homebrew/")) return "brew";
    if (combined.includes("/mise/")) return "mise";
    if (combined.includes("/volta/")) return "volta";
    if (combined.includes("/pnpm/") || combined.includes("/pnpm-global/")) return "pnpm";
    if (combined.includes("/.yarn/")) return "yarn";
    if (combined.includes("/.bun/") || combined.includes("/bun/")) return "bun";
    if (combined.includes("/fnm/")) return "fnm";
    if (combined.includes("/nvm/")) return "nvm";
    if (combined.includes("/npm/") || combined.includes("/node_modules/")) return "npm";

    // Check if it's a node script (npm-installed) vs standalone binary
    const headBuf = await readFile(resolved, "utf-8");
    const head = headBuf.slice(0, 20);
    if (head.startsWith("#!/")) return "npm";

    return "binary";
  } catch {
    return "npm";
  }
}

export async function GET() {
  let installed = "unknown";
  let latest = "unknown";
  let updateCommand = UPDATE_COMMANDS.npm;

  try {
    const { stdout } = await execFileAsync("claude", ["--version"], { timeout: 5000 });
    const match = stdout.trim().match(/^([\d.]+)/);
    if (match) installed = match[1];
  } catch {
    // CLI not found or errored
  }

  try {
    const res = await fetch("https://registry.npmjs.org/@anthropic-ai/claude-code/latest", {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.version) latest = data.version;
    }
  } catch {
    // network error
  }

  try {
    const method = await detectInstallMethod();
    updateCommand = UPDATE_COMMANDS[method];
  } catch {
    // fall back to npm
  }

  return NextResponse.json({ installed, latest, updateCommand });
}

export async function POST() {
  const method = await detectInstallMethod();
  if (method === "binary") {
    return NextResponse.json({ error: "Manual update required for standalone binary installs" }, { status: 400 });
  }

  const cmd = UPDATE_COMMANDS[method];
  const [bin, ...args] = cmd.split(" ");

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: 120_000,
      env: { ...process.env, PATH: process.env.PATH },
      shell: true,
    });
    return NextResponse.json({ ok: true, output: (stdout + "\n" + stderr).trim() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
