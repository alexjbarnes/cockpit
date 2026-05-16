/**
 * End-to-end: SessionManager driving a real `claude` PTY through the hook
 * router, with COCKPIT_PTY_RUNTIME=1 selecting the pty branch.
 *
 * Verifies the full chain: createSession -> sendMessage -> PtyRuntime spawns
 * claude -> hooks translate to ParsedEvents -> stream-processor flips status
 * to idle on Stop -> assistant message_done is emitted.
 *
 * Requires `claude` on PATH (or CLAUDE_BIN env). Slow.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ParsedEvent } from "@/server/event-parser";
import { HookRouter } from "@/server/hook-router";
import { SessionManager } from "@/server/session-manager";
import { setHookRouter } from "@/server/singleton";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CLAUDE_AVAILABLE = (() => {
  try {
    execSync(`${CLAUDE_BIN} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
// Integration tests spawn a real claude process and burn API credits + ~90s
// per test. Opt-in only: set COCKPIT_INTEGRATION_TESTS=1 to run.
const RUN_INTEGRATION = process.env.COCKPIT_INTEGRATION_TESTS === "1";

describe.skipIf(!RUN_INTEGRATION || !CLAUDE_AVAILABLE)("SessionManager + PTY runtime", () => {
  let hookRouter: HookRouter;
  let manager: SessionManager;
  let workDir: string;

  beforeAll(async () => {
    hookRouter = new HookRouter();
    await hookRouter.start();
    setHookRouter(hookRouter);
    manager = new SessionManager();
    workDir = mkdtempSync(join(tmpdir(), "cockpit-sm-pty-"));
    execSync("git init && git commit --allow-empty -m init", { cwd: workDir, stdio: "ignore" });
  });

  afterAll(async () => {
    await hookRouter.stop();
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  it("creates a pty-runtime session, drives it through the hook pipeline, returns to idle", async () => {
    const info = manager.createSession(workDir, "pty-test", { runtime: "pty" });

    const events: ParsedEvent[] = [];
    let stopResolve!: () => void;
    let idleResolve!: () => void;
    const messageDone = new Promise<void>((r) => {
      stopResolve = r;
    });
    const wentIdle = new Promise<void>((r) => {
      idleResolve = r;
    });

    const unsubEvent = manager.subscribe(info.id, (event) => {
      events.push(event);
      if (event.type === "message_done") stopResolve();
    });
    const unsubStatus = manager.onStatus(info.id, (status) => {
      if (status === "idle") idleResolve();
    });
    expect(unsubEvent).not.toBeNull();
    expect(unsubStatus).not.toBeNull();

    const sent = manager.sendMessage(info.id, "Reply with just the single word: pong. No tools, no explanation.");
    expect(sent).toBe(true);

    await Promise.race([
      Promise.all([messageDone, wentIdle]).then(() => {}),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Stop/idle never fired")), 90_000)),
    ]);

    expect(events.some((e) => e.type === "message_done")).toBe(true);

    unsubEvent?.();
    unsubStatus?.();
    manager.destroySession(info.id);
  }, 120_000);
});
