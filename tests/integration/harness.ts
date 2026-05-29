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
import type { ThinkingLevel } from "../../src/types";
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
  /** Override the default thinking level. Defaults to "high". */
  thinkingLevel?: ThinkingLevel;
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-"));
  const configDir = path.join(rootDir, "cockpit");
  const claudeDir = path.join(rootDir, "claude");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });

  // Pre-seed the CLI's .claude.json so the TUI skips its onboarding flow.
  // Real users complete this once interactively on install and never see it
  // again; tests get a fresh CLAUDE_CONFIG_DIR every run, so we mimic the
  // post-onboarding state. theme + hasCompletedOnboarding skips the welcome
  // and security-notes screens. The trust prompt is handled by cockpit's
  // pty-session.handleTrustDialog at runtime — no seed needed. The bypass
  // prompt is suppressed by skipDangerousModePermissionPrompt that cockpit
  // writes into the per-session settings.json (see claude-settings.ts).
  writeFileSync(path.join(claudeDir, ".claude.json"), JSON.stringify({ theme: "dark", hasCompletedOnboarding: true }, null, 2));

  const mock = await createMockApiServer();

  seedConfig({
    configDir,
    mockUrl: `http://127.0.0.1:${mock.port}`,
    thinkingLevel: opts.thinkingLevel,
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
  thinkingLevel?: ThinkingLevel;
}

function seedConfig(opts: SeedOpts): void {
  // password.json: validateSession() requires a stored password to compute
  // a signing key BEFORE the COCKPIT_TOKEN bypass kicks in. Write a dummy.
  const salt = randomBytes(32);
  const hash = scryptSync("integration-test-password", salt, 64);
  writeFileSync(path.join(opts.configDir, "password.json"), JSON.stringify({ hash: hash.toString("hex"), salt: salt.toString("hex") }));

  // providers.json: one custom provider pointing the CLI at the mock.
  // cockpit's session-manager assigns provider.envVars into the spawned CLI's
  // env, so each var is wired through:
  //   ANTHROPIC_BASE_URL    — redirects /v1/messages to the mock
  //   ANTHROPIC_AUTH_TOKEN  — CLI sends as Authorization: Bearer (no prompt).
  //     ANTHROPIC_API_KEY would trigger a TUI "Detected a custom API key in
  //     your environment, use it? 1. Yes 2. No (recommended)" prompt that the
  //     PTY can't easily dismiss.
  //   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC — skip bootstrap, telemetry
  // Model IDs are real Anthropic names (claude-sonnet-4-6) so the CLI's
  // hardcoded model-availability list accepts them.
  const provider = {
    id: "mock",
    name: "Mock API",
    envVars: {
      ANTHROPIC_BASE_URL: opts.mockUrl,
      ANTHROPIC_AUTH_TOKEN: "mock-token",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
    },
    models: [
      {
        modelId: "claude-sonnet-4-6",
        displayName: "Mock Sonnet",
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
        contextSizes: ["200k", "1m"],
      },
      {
        modelId: "claude-opus-4-7",
        displayName: "Mock Opus 4.7",
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
        contextSizes: ["200k", "1m"],
      },
      {
        modelId: "claude-opus-4-8",
        displayName: "Mock Opus 4.8",
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
        contextSizes: ["200k", "1m"],
      },
      {
        modelId: "claude-haiku-4-5-20251001",
        displayName: "Mock Haiku",
        effortLevels: [],
        contextSizes: ["200k"],
      },
      // Regression fixture: a model with NO contextSizes field, mirroring a
      // legacy custom-provider entry written before contextSizes existed (e.g.
      // a Deepseek config carrying the old supportsExtendedContext flag). The
      // type says contextSizes is required, but persisted JSON predating the
      // field has it undefined. Opening the session-settings dialog on such a
      // model used to crash with "Cannot read properties of undefined (reading
      // 'length')". Covered by model-selector.spec.ts.
      {
        modelId: "claude-sonnet-4-6-legacy",
        displayName: "Mock Legacy (no contextSizes)",
        effortLevels: ["high", "max"],
      },
    ],
  };
  writeFileSync(path.join(opts.configDir, "providers.json"), JSON.stringify([provider], null, 2) + "\n");

  // defaults.json: pick the mock model so new sessions use it by default.
  // The qualified form provider:modelId is what resolveProviderModel expects.
  // bypassAllPermissions mirrors how most cockpit users configure their setup;
  // the resulting CLI bypass-mode dialog is suppressed via cockpit's per-session
  // settings.json (skipDangerousModePermissionPrompt).
  writeFileSync(
    path.join(opts.configDir, "defaults.json"),
    JSON.stringify(
      {
        modelSlots: { main: "mock:claude-sonnet-4-6", mainContext: "200k" },
        thinkingLevel: opts.thinkingLevel ?? "high",
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
  // Use the compiled dist/ instead of `npx tsx server.ts`. tsx incurs ~10s
  // TypeScript transpile cost per process that we can't afford in a 60s
  // per-test timeout. pretest:integration ensures dist/ is fresh.
  return spawn("node", ["dist/server.js"], {
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
      // Surface cockpit's debugLog() output to stdout (which we capture when
      // COCKPIT_IT_DEBUG=1). Without this, debugLog goes only to debug.jsonl.
      COCKPIT_DEBUG: "1",
      // Avoid colour codes in captured stdout.
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    // Put cockpit in its own process group so we can SIGTERM the WHOLE tree
    // (cockpit + every CLI it spawned via node-pty + cli-init-fetch). Without
    // this, killing cockpit leaves orphan claude processes that keep running
    // and pile up across test runs — the box can end up with 10+ leaked
    // tsx/claude processes after a flaky suite.
    detached: true,
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
  const pgid = proc.pid;
  return new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
    try {
      // Negative pid = signal the whole process group (cockpit + every CLI it
      // spawned). Requires detached:true on spawn. Without group kill, orphan
      // CLI processes survive and pile up across runs.
      process.kill(-pgid, "SIGTERM");
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
        resolve();
        return;
      }
    }
    setTimeout(() => {
      if (proc.exitCode == null) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          try {
            proc.kill("SIGKILL");
          } catch {
            // already dead
          }
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
