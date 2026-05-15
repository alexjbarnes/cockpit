/**
 * End-to-end integration: spawn a real `claude` process via PtySession,
 * wired up to a real HookRouter through a real settings file, and verify
 * that hooks flow back to our handler.
 *
 * Requires `claude` on PATH (or CLAUDE_BIN env). Slow — single test that
 * exercises the full Phase 1+2+3 stack.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupHookSettings, prepareHookSettings } from "@/server/claude-settings";
import { HookRouter, type PermissionDecision } from "@/server/hook-router";
import { PtySession } from "@/server/pty-session";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CLAUDE_AVAILABLE = (() => {
  try {
    execSync(`${CLAUDE_BIN} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!CLAUDE_AVAILABLE)("PtySession + HookRouter integration", () => {
  let router: HookRouter;
  let workDir: string;
  const sessionId = "integration-session";

  beforeAll(async () => {
    router = new HookRouter();
    await router.start();
    workDir = mkdtempSync(join(tmpdir(), "cockpit-pty-int-"));
    execSync("git init && git commit --allow-empty -m init", { cwd: workDir, stdio: "ignore" });
  });

  afterAll(async () => {
    await router.stop();
    await cleanupHookSettings(sessionId);
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  it("spawns claude, captures UserPromptSubmit + Stop, auto-allows Write via PermissionRequest hook", async () => {
    const events: { name: string; payload: Record<string, unknown> }[] = [];
    let stopResolve!: () => void;
    const stopped = new Promise<void>((r) => {
      stopResolve = r;
    });

    const token = router.register(sessionId, {
      onUserPromptSubmit(payload) {
        events.push({ name: "UserPromptSubmit", payload });
      },
      onPostToolUse(payload) {
        events.push({ name: "PostToolUse", payload });
      },
      onPermissionRequest(payload): Promise<PermissionDecision> {
        events.push({ name: "PermissionRequest", payload });
        return Promise.resolve({ behavior: "allow" });
      },
      onStop(payload) {
        events.push({ name: "Stop", payload });
        stopResolve();
      },
    });

    const { settingsPath, env } = await prepareHookSettings({
      sessionId,
      hookUrl: router.getUrl(),
      hookToken: token,
      // Pre-allow Read/Glob/Grep so claude doesn't pause on those.
      allowList: ["Read(*)", "Glob(*)", "Grep(*)"],
    });

    const pty = new PtySession({ cwd: workDir, settingsPath, env });
    try {
      await pty.start();
      await pty.sendText('Create a file called hi.txt containing exactly "hi" and nothing else. Do not explain, just create the file.');
      await Promise.race([stopped, new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Stop hook never fired")), 90_000))]);
    } finally {
      pty.kill();
    }

    const names = events.map((e) => e.name);
    expect(names).toContain("UserPromptSubmit");
    expect(names).toContain("PermissionRequest");
    expect(names).toContain("PostToolUse");
    expect(names).toContain("Stop");

    const perm = events.find((e) => e.name === "PermissionRequest");
    expect((perm?.payload as { tool_name?: string }).tool_name).toBe("Write");

    const filePath = join(workDir, "hi.txt");
    expect(existsSync(filePath)).toBe(true);
  }, 120_000);
});
