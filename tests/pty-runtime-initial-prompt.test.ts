import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookRouter, SessionHookHandler } from "@/server/hook-router";

// Mock the low-level PTY so no real claude process spawns. sendText resolves
// immediately; the real 300ms text-to-Enter delay lives in PtySession, which
// we replace here.
const ptySessionMock = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  sendText: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
}));

vi.mock("@/server/pty-session", () => ({
  PtySession: class {
    pid = 4321;
    start() {
      return ptySessionMock.start();
    }
    sendText(text: string) {
      return ptySessionMock.sendText(text);
    }
    kill(signal?: string) {
      return ptySessionMock.kill(signal);
    }
    resize() {}
    sendSlash() {}
    sendKey() {}
  },
}));

vi.mock("@/server/claude-settings", () => ({
  prepareHookSettings: vi.fn().mockResolvedValue({ settingsPath: "/tmp/settings.json", env: {} }),
  cleanupHookSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server/cli-init-fetch", () => ({
  fetchCliInitData: vi.fn().mockResolvedValue(null),
}));

import { PtyRuntime } from "@/server/pty-runtime";

function makeRuntime(): { runtime: PtyRuntime; getHandler: () => SessionHookHandler | null } {
  let handler: SessionHookHandler | null = null;
  const router = {
    register: vi.fn((_sessionId: string, h: SessionHookHandler) => {
      handler = h;
      return "mock-token";
    }),
    unregister: vi.fn(),
    getUrl: vi.fn(() => "http://localhost:9999/hook"),
  } as unknown as HookRouter;

  const runtime = new PtyRuntime({
    sessionId: "sess-1",
    cwd: "/tmp/job",
    cliSessionId: "sess-1",
    hookRouter: router,
    onEvents: () => {},
    onError: () => {},
    onExit: () => {},
  });

  return { runtime, getHandler: () => handler };
}

describe("PtyRuntime initial-prompt delivery", () => {
  beforeEach(() => {
    ptySessionMock.start.mockClear().mockResolvedValue(undefined);
    ptySessionMock.sendText.mockClear().mockResolvedValue(undefined);
    ptySessionMock.kill.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("types the prompt once when UserPromptSubmit confirms acceptance", async () => {
    const { runtime, getHandler } = makeRuntime();

    const started = runtime.start("run the job");
    await vi.waitFor(() => expect(ptySessionMock.sendText).toHaveBeenCalledWith("run the job"));

    // Simulate the CLI accepting the prompt and firing the hook.
    getHandler()?.onUserPromptSubmit?.({ prompt: "run the job", session_id: "sess-1" });

    await started;
    expect(ptySessionMock.sendText).toHaveBeenCalledTimes(1);
  });

  it("resends the prompt when the first attempt is not confirmed", async () => {
    vi.useFakeTimers();
    const { runtime, getHandler } = makeRuntime();

    const started = runtime.start("run the job");

    // Attempt 1 types, then waits for confirmation.
    await vi.advanceTimersByTimeAsync(0);
    expect(ptySessionMock.sendText).toHaveBeenCalledTimes(1);

    // No confirmation arrives; the confirm window lapses and it retries.
    await vi.advanceTimersByTimeAsync(8000);
    expect(ptySessionMock.sendText).toHaveBeenCalledTimes(2);

    // Attempt 2 is confirmed.
    getHandler()?.onUserPromptSubmit?.({ prompt: "run the job" });
    await vi.advanceTimersByTimeAsync(0);

    await started;
    expect(ptySessionMock.sendText).toHaveBeenCalledTimes(2);
  });

  it("rejects after exhausting retries so the caller fails fast instead of hanging", async () => {
    vi.useFakeTimers();
    const { runtime } = makeRuntime();

    const started = runtime.start("run the job");
    started.catch(() => {}); // avoid unhandled-rejection noise before we assert

    // Four attempts, each waiting the full confirm window with no confirmation.
    await vi.advanceTimersByTimeAsync(8000 * 4 + 50);

    await expect(started).rejects.toThrow(/did not accept the initial prompt/);
    expect(ptySessionMock.sendText).toHaveBeenCalledTimes(4);
  });
});
