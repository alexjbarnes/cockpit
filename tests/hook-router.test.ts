import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveHookBridgePath } from "@/server/hook-bridge-path";
import { HookRouter, type PermissionDecision } from "@/server/hook-router";

const BRIDGE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cockpit-hook-bridge.mjs");

interface BridgeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runBridge(args: string[], env: Record<string, string>, stdinPayload: string): Promise<BridgeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [BRIDGE_PATH, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

describe("HookRouter + bridge round-trip", () => {
  let router: HookRouter;
  let url: string;

  beforeAll(async () => {
    router = new HookRouter();
    const addr = await router.start();
    url = `http://${addr.host}:${addr.port}`;
  });

  afterAll(async () => {
    await router.stop();
  });

  it("delivers PostToolUse payload to handler and returns exit 0", async () => {
    const sessionId = "session-a";
    let received: Record<string, unknown> | null = null;
    const token = router.register(sessionId, {
      onPostToolUse(payload) {
        received = payload;
      },
    });

    const payload = { tool_name: "Bash", tool_input: { command: "ls" } };
    const res = await runBridge(
      ["PostToolUse"],
      { COCKPIT_HOOK_URL: url, COCKPIT_HOOK_TOKEN: token, COCKPIT_SESSION_ID: sessionId },
      JSON.stringify(payload),
    );

    expect(res.exitCode).toBe(0);
    expect(received).toEqual(payload);

    router.unregister(sessionId);
  });

  it("delivers PermissionRequest payload and returns the decision JSON to stdout", async () => {
    const sessionId = "session-b";
    let received: Record<string, unknown> | null = null;
    const decision: PermissionDecision = { behavior: "allow" };
    const token = router.register(sessionId, {
      async onPermissionRequest(payload) {
        received = payload;
        return decision;
      },
    });

    const payload = { tool_name: "Write", tool_input: { file_path: "/tmp/x.txt" } };
    const res = await runBridge(
      ["PermissionRequest"],
      { COCKPIT_HOOK_URL: url, COCKPIT_HOOK_TOKEN: token, COCKPIT_SESSION_ID: sessionId },
      JSON.stringify(payload),
    );

    expect(res.exitCode).toBe(0);
    expect(received).toEqual(payload);

    const parsed = JSON.parse(res.stdout) as {
      hookSpecificOutput: { hookEventName: string; decision: PermissionDecision };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
    expect(parsed.hookSpecificOutput.decision).toEqual(decision);

    router.unregister(sessionId);
  });

  it("blocks until permission handler resolves (simulating user think time)", async () => {
    const sessionId = "session-c";
    const token = router.register(sessionId, {
      onPermissionRequest: () =>
        new Promise<PermissionDecision>((resolve) => {
          setTimeout(() => resolve({ behavior: "deny", message: "nope" }), 250);
        }),
    });

    const t0 = Date.now();
    const res = await runBridge(
      ["PermissionRequest"],
      { COCKPIT_HOOK_URL: url, COCKPIT_HOOK_TOKEN: token, COCKPIT_SESSION_ID: sessionId },
      JSON.stringify({ tool_name: "Bash" }),
    );
    const elapsed = Date.now() - t0;

    expect(res.exitCode).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(240);
    const parsed = JSON.parse(res.stdout) as {
      hookSpecificOutput: { decision: PermissionDecision };
    };
    expect(parsed.hookSpecificOutput.decision).toEqual({ behavior: "deny", message: "nope" });

    router.unregister(sessionId);
  });

  it("rejects requests with wrong token", async () => {
    const sessionId = "session-d";
    router.register(sessionId, { onStop: () => {} });

    const res = await runBridge(
      ["Stop"],
      { COCKPIT_HOOK_URL: url, COCKPIT_HOOK_TOKEN: "wrong-token", COCKPIT_SESSION_ID: sessionId },
      "{}",
    );

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("router returned 403");

    router.unregister(sessionId);
  });

  it("rejects requests for unknown session", async () => {
    const res = await runBridge(
      ["Stop"],
      { COCKPIT_HOOK_URL: url, COCKPIT_HOOK_TOKEN: "any-token", COCKPIT_SESSION_ID: "missing-session" },
      "{}",
    );

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("router returned 403");
  });

  it("resolves the bridge path to the same file the tests run against", () => {
    expect(resolveHookBridgePath()).toBe(BRIDGE_PATH);
  });
});
