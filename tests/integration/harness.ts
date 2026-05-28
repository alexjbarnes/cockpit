// Integration test harness: mock API + cockpit server + isolated config dirs.
//
// startHarness() boots three things:
//   1. A mock Anthropic API on a random port (replays scripted SSE).
//   2. A tmpdir holding COCKPIT_CONFIG_DIR and CLAUDE_CONFIG_DIR contents.
//      Seeded with a password.json (so COCKPIT_TOKEN bypass works) and a
//      providers.json containing one custom provider that points the CLI at
//      the mock.
//   3. A cockpit server (tsx server.ts) spawned with COCKPIT_TOKEN +
//      COCKPIT_CONFIG_DIR + CLAUDE_CONFIG_DIR + a random PORT.
//
// stopHarness() tears everything down and removes the tmpdir.

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { createMockApiServer, type MockApiServer } from "../mock-api/server";

export interface Harness {
  mock: MockApiServer;
  cockpitPort: number;
  cockpitUrl: string;
  cockpitToken: string;
  configDir: string;
  claudeDir: string;
  /** Tear down server, mock, and tmpdir. */
  stop(): Promise<void>;
}

export interface HarnessOptions {
  /** Path to the claude binary. Defaults to CLAUDE_BIN env or "claude". */
  claudeBin?: string;
  /** Override the cockpit runtime mode. Defaults to "pty". */
  runtime?: "pty" | "stream";
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-"));
  const configDir = path.join(rootDir, "cockpit");
  const claudeDir = path.join(rootDir, "claude");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });

  const mock = await createMockApiServer();

  seedConfig({
    configDir,
    mockUrl: `http://127.0.0.1:${mock.port}`,
  });

  const cockpitPort = await getFreePort();
  const cockpitToken = uuidv4();

  const proc = spawnCockpit({
    cockpitPort,
    cockpitToken,
    configDir,
    claudeDir,
    runtime: opts.runtime ?? "pty",
    claudeBin: opts.claudeBin ?? process.env.CLAUDE_BIN ?? "claude",
  });
  if (process.env.COCKPIT_IT_DEBUG === "1") captureCockpitLogs(proc);

  await waitForCockpitReady(cockpitPort);

  return {
    mock,
    cockpitPort,
    cockpitUrl: `http://127.0.0.1:${cockpitPort}`,
    cockpitToken,
    configDir,
    claudeDir,
    async stop() {
      await stopProcess(proc);
      await mock.stop();
      try {
        rmSync(rootDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Config seeding
// ──────────────────────────────────────────────────────────────────────

interface SeedOpts {
  configDir: string;
  mockUrl: string;
}

function seedConfig(opts: SeedOpts): void {
  // password.json: validateSession() requires a stored password to compute
  // a signing key BEFORE the COCKPIT_TOKEN bypass kicks in. Write a dummy.
  const salt = randomBytes(32);
  const hash = scryptSync("integration-test-password", salt, 64);
  writeFileSync(path.join(opts.configDir, "password.json"), JSON.stringify({ hash: hash.toString("hex"), salt: salt.toString("hex") }));

  // providers.json: one custom provider pointing the CLI at the mock.
  // cockpit's session-manager assigns provider.envVars into the spawned CLI's
  // env, so ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN are wired through.
  const provider = {
    id: "mock",
    name: "Mock API",
    envVars: {
      ANTHROPIC_BASE_URL: opts.mockUrl,
      ANTHROPIC_AUTH_TOKEN: "mock-token",
    },
    models: [
      {
        modelId: "mock-sonnet",
        displayName: "Mock Sonnet",
        effortLevels: [],
        contextSizes: ["200k"],
      },
    ],
  };
  writeFileSync(path.join(opts.configDir, "providers.json"), JSON.stringify([provider], null, 2) + "\n");

  // defaults.json: pick the mock model so new sessions use it by default.
  // The qualified form provider:modelId is what resolveProviderModel expects.
  writeFileSync(
    path.join(opts.configDir, "defaults.json"),
    JSON.stringify(
      {
        modelSlots: { main: "mock:mock-sonnet", mainContext: "200k" },
        thinkingLevel: "high",
        bypassAllPermissions: true,
      },
      null,
      2,
    ) + "\n",
  );
}

// ──────────────────────────────────────────────────────────────────────
// Cockpit process management
// ──────────────────────────────────────────────────────────────────────

interface SpawnOpts {
  cockpitPort: number;
  cockpitToken: string;
  configDir: string;
  claudeDir: string;
  runtime: "pty" | "stream";
  claudeBin: string;
}

function spawnCockpit(opts: SpawnOpts): ChildProcess {
  const repoRoot = path.resolve(__dirname, "..", "..");
  return spawn("npx", ["tsx", "server.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(opts.cockpitPort),
      HOST: "127.0.0.1",
      COCKPIT_TOKEN: opts.cockpitToken,
      COCKPIT_CONFIG_DIR: opts.configDir,
      CLAUDE_CONFIG_DIR: opts.claudeDir,
      COCKPIT_RUNTIME: opts.runtime,
      CLAUDE_BIN: opts.claudeBin,
      // Production mode: serves the prebuilt .next/ bundle. Run `npm run build`
      // before the integration suite (the pretest:integration script does this).
      // Dev mode is rejected because Next.js dev singleton-locks the project
      // directory, so we can't run alongside a developer's dev server.
      NODE_ENV: "production",
      // Avoid colour codes in captured stdout.
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function captureCockpitLogs(proc: ChildProcess, prefix = "[cockpit]"): void {
  proc.stdout?.on("data", (d) => process.stdout.write(`${prefix} ${d}`));
  proc.stderr?.on("data", (d) => process.stderr.write(`${prefix} ${d}`));
}

async function waitForCockpitReady(port: number, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/check`);
      // Any HTTP response means the server is up. 401 (unauthenticated) is
      // expected without a cookie — that's fine; we just need it bound.
      if (res.status === 200 || res.status === 401) return;
    } catch {
      // Connection refused while server still starting.
    }
    await sleep(250);
  }
  throw new Error(`Cockpit did not become ready on port ${port} within ${timeoutMs}ms`);
}

async function stopProcess(proc: ChildProcess): Promise<void> {
  if (!proc.pid || proc.exitCode != null) return;
  return new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
    try {
      proc.kill("SIGTERM");
    } catch {
      resolve();
      return;
    }
    setTimeout(() => {
      if (proc.exitCode == null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already dead
        }
      }
    }, 3_000);
  });
}

// ──────────────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("failed to get free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
