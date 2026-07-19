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

// Controllable transcript message count. deliverInitialPrompt reads this to
// detect that a turn started (the prompt was accepted) even when the
// UserPromptSubmit hook is lost.
const transcriptMock = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/server/transcript", () => ({
  countTranscriptMessages: () => transcriptMock.count,
}));

import { ONE_M_CREDITS_REQUIRED } from "@/server/event-parser";
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
    transcriptMock.count = 0;
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

  it("treats a started turn as acceptance when the hook is lost, instead of resending or failing", async () => {
    vi.useFakeTimers();
    const { runtime } = makeRuntime();

    const started = runtime.start("run the job");

    // Attempt 1 types the prompt, then waits for confirmation.
    await vi.advanceTimersByTimeAsync(0);
    expect(ptySessionMock.sendText).toHaveBeenCalledTimes(1);

    // The hook never fires, but the CLI accepts the prompt and writes a turn to
    // the transcript. The end-of-window transcript check picks it up.
    transcriptMock.count = 1;
    await vi.advanceTimersByTimeAsync(8000);

    // Resolves instead of throwing, and never resends into the live turn.
    await started;
    expect(ptySessionMock.sendText).toHaveBeenCalledTimes(1);
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

describe("PtyRuntime interactive user send (sendUserText)", () => {
  beforeEach(() => {
    ptySessionMock.start.mockClear().mockResolvedValue(undefined);
    ptySessionMock.sendText.mockClear().mockResolvedValue(undefined);
    transcriptMock.count = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Start a runtime and confirm its initial prompt so we reach a live REPL, then
  // clear the spy so assertions see only the interactive send.
  async function startedRuntime() {
    const { runtime, getHandler } = makeRuntime();
    const started = runtime.start("init");
    await vi.advanceTimersByTimeAsync(0);
    getHandler()?.onUserPromptSubmit?.({ prompt: "init" });
    await started;
    ptySessionMock.sendText.mockClear();
    return runtime;
  }

  it("logs 'NO turn' when an interactive send writes no transcript turn (swallowed input)", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runtime = await startedRuntime();
    transcriptMock.count = 5; // baseline at send time

    await runtime.sendUserText("@reviewer take a look");
    expect(ptySessionMock.sendText).toHaveBeenCalledWith("@reviewer take a look");

    // Transcript never grows in the window -> the send produced no turn.
    await vi.advanceTimersByTimeAsync(12000);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("produced NO turn"));
    logSpy.mockRestore();
  });

  it("stays quiet when the interactive send starts a turn (transcript grows)", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runtime = await startedRuntime();
    transcriptMock.count = 5;

    await runtime.sendUserText("hello");
    transcriptMock.count = 6; // a user turn was written

    await vi.advanceTimersByTimeAsync(12000);
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("produced NO turn"));
    logSpy.mockRestore();
  });
});

describe("PtyRuntime API error scanning", () => {
  function runtimeWithSpies() {
    const onError = vi.fn();
    const onEvents = vi.fn();
    const router = {
      register: vi.fn(() => "tok"),
      unregister: vi.fn(),
      getUrl: vi.fn(() => "http://localhost:9999/hook"),
    } as unknown as HookRouter;
    const runtime = new PtyRuntime({
      sessionId: "sess-err",
      cwd: "/tmp",
      cliSessionId: "sess-err",
      hookRouter: router,
      onEvents,
      onError,
      onExit: () => {},
    });
    return { runtime, onError, onEvents };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("surfaces the 1M-credits sentinel immediately and forces the turn idle", () => {
    const { runtime, onError, onEvents } = runtimeWithSpies();
    (runtime as any).scanForErrors(
      "❯ API Error: Usage credits required for 1M context · turn on usage credits at claude.ai/settings/usage",
    );
    expect(onError).toHaveBeenCalledWith(ONE_M_CREDITS_REQUIRED);
    expect(onEvents).toHaveBeenCalledTimes(1);
    expect(onEvents.mock.calls[0][0][0].type).toBe("message_done");
  });

  it("fires the 1M-credits sentinel only once per spawn", () => {
    const { runtime, onError } = runtimeWithSpies();
    (runtime as any).scanForErrors("API Error: Usage credits required for 1M context");
    (runtime as any).scanForErrors("API Error: Usage credits required for 1M context again");
    expect(onError.mock.calls.filter((c) => c[0] === ONE_M_CREDITS_REQUIRED)).toHaveLength(1);
  });

  it("still debounces coded API errors and does not confuse them with the credits case", () => {
    vi.useFakeTimers();
    const { runtime, onError } = runtimeWithSpies();
    (runtime as any).scanForErrors("API Error: 529 overloaded");
    expect(onError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain("529");
  });
});
