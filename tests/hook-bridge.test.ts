// Regression tests for bin/cockpit-hook-bridge.mjs.
//
// The bridge posts each Claude hook to cockpit's hook-router and waits for the
// response. For PermissionRequest the router holds that response open until the
// user answers the AskUserQuestion — which can be many minutes. The bridge used
// to use the global fetch(); Node's fetch is undici, whose default
// headersTimeout/bodyTimeout are 5 minutes, so a slow answer aborted the request
// and the CLI hung with no decision (and the user's eventual click landed on a
// dead socket). The bridge now uses node:http, whose only ceiling is the explicit
// timeout below, and always emits a deny decision on failure so the CLI never
// hangs waiting for a decision that will never come.

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const BRIDGE = path.resolve(process.cwd(), "bin/cockpit-hook-bridge.mjs");
const TOKEN = "test-token";
const SESSION = "test-session-id";

interface RouterBehaviour {
  /** ms to hold the response before replying */
  hold?: number;
  /** status code to send (default 200) */
  status?: number;
  /** JSON body to send */
  body?: unknown;
}

function startRouter(behaviour: RouterBehaviour): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    // drain request body, then apply the behaviour
    req.on("data", () => {});
    req.on("end", () => {
      const reply = () => {
        res.statusCode = behaviour.status ?? 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(behaviour.body ?? {}));
      };
      if (behaviour.hold && behaviour.hold > 0) setTimeout(reply, behaviour.hold);
      else reply();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

interface BridgeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

function runBridge(eventName: string, opts: { hookUrl: string; payload?: string; env?: Record<string, string> }): Promise<BridgeResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, [BRIDGE, eventName], {
      env: {
        ...process.env,
        COCKPIT_HOOK_URL: opts.hookUrl,
        COCKPIT_HOOK_TOKEN: TOKEN,
        COCKPIT_SESSION_ID: SESSION,
        ...opts.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr, elapsedMs: Date.now() - start }));
    child.stdin.end(opts.payload ?? "{}");
  });
}

let active: Server | null = null;
afterEach(async () => {
  if (active) {
    await new Promise<void>((r) => active!.close(() => r()));
    active = null;
  }
});

describe("cockpit-hook-bridge", () => {
  it("returns the router's decision for a permission response held open", async () => {
    const decision = JSON.stringify({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
    const { url, server } = await startRouter({ hold: 1500, body: { stdout: decision, exitCode: 0 } });
    active = server;

    const r = await runBridge("PermissionRequest", { hookUrl: url });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe(decision);
    // It actually waited for the held response rather than bailing early.
    expect(r.elapsedMs).toBeGreaterThanOrEqual(1400);
  });

  it("emits a deny decision when the answer exceeds the permission timeout", async () => {
    // Router never replies in time; the bridge's own cap fires.
    const { url, server } = await startRouter({ hold: 5000, body: { stdout: "late", exitCode: 0 } });
    active = server;

    const r = await runBridge("PermissionRequest", {
      hookUrl: url,
      env: { COCKPIT_PERMISSION_HOOK_TIMEOUT_MS: "600" },
    });

    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.decision.behavior).toBe("deny");
    // Timed out at ~600ms, did not wait the full 5s hold.
    expect(r.elapsedMs).toBeLessThan(3000);
  });

  it("emits a deny decision when the router returns a non-2xx", async () => {
    const { url, server } = await startRouter({ status: 500, body: {} });
    active = server;

    const r = await runBridge("PermissionRequest", { hookUrl: url });

    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.decision.behavior).toBe("deny");
  });

  it("emits a deny decision when cockpit is unreachable", async () => {
    // Bind then immediately close to get a port that refuses connections.
    const { url, server } = await startRouter({});
    await new Promise<void>((r) => server.close(() => r()));

    const r = await runBridge("PermissionRequest", { hookUrl: url });

    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.decision.behavior).toBe("deny");
  });

  it("passes through stdout and exit code for non-permission hooks", async () => {
    const { url, server } = await startRouter({ body: { stdout: "from-router", exitCode: 2 } });
    active = server;

    const r = await runBridge("PreToolUse", { hookUrl: url });

    expect(r.code).toBe(2);
    expect(r.stdout).toBe("from-router");
  });

  // The original bug: a permission response held longer than undici's 5-minute
  // fetch ceiling. node:http has no such ceiling. Slow (>5 min); opt in with
  // RUN_SLOW_HOOK_TESTS=1.
  it.skipIf(!process.env.RUN_SLOW_HOOK_TESTS)(
    "tolerates a permission response held past undici's 5-minute fetch ceiling",
    async () => {
      const decision = JSON.stringify({
        hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
      });
      const { url, server } = await startRouter({ hold: 320_000, body: { stdout: decision, exitCode: 0 } });
      active = server;

      const r = await runBridge("PermissionRequest", { hookUrl: url });

      expect(r.code).toBe(0);
      expect(r.stdout).toBe(decision);
      expect(r.elapsedMs).toBeGreaterThan(300_000);
    },
    360_000,
  );
});
