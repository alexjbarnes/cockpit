// Starting and stopping the tour's own cockpit: the built server (dist/), on a
// spare port, against the tour's config folder and a CLI config folder of its
// own, so nothing of the machine's real cockpit, sessions or keys is in shot.

import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

export interface TourDirs {
  root: string;
  home: string;
  config: string;
  claude: string;
}

export interface RunningCockpit {
  url: string;
  port: number;
  token: string;
  stop(): Promise<void>;
}

const repoRoot = path.resolve(__dirname, "..", "..");

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (!address || typeof address === "string") return reject(new Error("no port"));
      srv.close(() => resolve(address.port));
    });
  });
}

/** The parent's environment without anything that marks a Claude Code
 *  session or its telemetry: a CLI that inherits CLAUDECODE takes itself for a
 *  nested run and writes no transcript. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_") || key.startsWith("OTEL_") || key.startsWith("COCKPIT_")) continue;
    if (key.startsWith("ANTHROPIC_") || key.startsWith("XDG_")) continue;
    env[key] = value;
  }
  return env;
}

export async function startCockpit(dirs: TourDirs, mockUrl: string, token: string, log?: (line: string) => void): Promise<RunningCockpit> {
  const port = await freePort();
  const proc: ChildProcess = spawn("node", ["dist/server.js"], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...cleanEnv(),
      HOME: dirs.home,
      SHELL: "/bin/bash",
      XDG_CONFIG_HOME: `${dirs.home}/.config`,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      FORCE_COLOR: "0",
      COCKPIT_TOKEN: token,
      COCKPIT_CONFIG_DIR: dirs.config,
      CLAUDE_CONFIG_DIR: dirs.claude,
      COCKPIT_RUNTIME: "pty",
      // Anthropic's own models reach the tour's API the way any CLI would.
      ANTHROPIC_BASE_URL: mockUrl,
      ANTHROPIC_AUTH_TOKEN: "tour",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      // The built-in providers' upstreams and catalogues, likewise.
      COCKPIT_OPENROUTER_BASE_URL: mockUrl,
      COCKPIT_DEEPSEEK_BASE_URL: mockUrl,
      COCKPIT_ZEN_BASE_URL: `${mockUrl}/v1`,
      COCKPIT_ZEN_GO_BASE_URL: `${mockUrl}/v1`,
      COCKPIT_GROQ_BASE_URL: `${mockUrl}/v1`,
      COCKPIT_GEMINI_BASE_URL: `${mockUrl}/v1`,
      COCKPIT_NVIDIA_BASE_URL: `${mockUrl}/v1`,
      COCKPIT_COMMANDCODE_BASE_URL: `${mockUrl}/v1`,
    },
  });
  if (log) {
    proc.stdout?.on("data", (d) => log(String(d)));
    proc.stderr?.on("data", (d) => log(String(d)));
  }
  const url = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${url}/api/auth/check`);
      if (res.status === 200 || res.status === 401) break;
    } catch {
      // Still starting.
    }
    if (Date.now() - started > 60_000) throw new Error("cockpit did not start");
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    url,
    port,
    token,
    stop: () =>
      new Promise<void>((resolve) => {
        if (!proc.pid || proc.exitCode !== null) return resolve();
        proc.once("exit", () => resolve());
        try {
          process.kill(-proc.pid, "SIGTERM");
        } catch {
          resolve();
        }
        setTimeout(() => {
          try {
            if (proc.pid && proc.exitCode === null) process.kill(-proc.pid, "SIGKILL");
          } catch {
            // Gone already.
          }
        }, 4_000);
      }),
  };
}
