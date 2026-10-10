// Messages typed into the CLI while a turn is under way. The CLI queues them
// itself and hands each to the model with the next tool result, or runs it as
// a turn of its own once the turn ends. PtyRuntime has to tell those apart
// from the transcript, to keep the session working through the second.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookRouter, SessionHookHandler } from "@/server/hook-router";

const ptySessionMock = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  sendText: vi.fn().mockResolvedValue(undefined),
  sendKey: vi.fn(),
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
    sendKey(key: string) {
      return ptySessionMock.sendKey(key);
    }
  },
}));

vi.mock("@/server/claude-settings", () => ({
  prepareHookSettings: vi.fn().mockResolvedValue({ settingsPath: "/tmp/settings.json", env: {} }),
  cleanupHookSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server/cli-init-fetch", () => ({
  fetchCliInitData: vi.fn().mockResolvedValue(null),
}));

import { type ParsedEvent, TURN_CONTINUES } from "@/server/event-parser";
import { PtyRuntime } from "@/server/pty-runtime";

const SESSION = "11111111-2222-3333-4444-555555555555";
const CWD = "/work/repo";

describe("PtyRuntime mid-turn messages", () => {
  const savedClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  let claudeDir: string;
  let transcript: string;

  beforeEach(() => {
    claudeDir = mkdtempSync(path.join(tmpdir(), "cockpit-midturn-"));
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    const folder = path.join(claudeDir, "projects", CWD.replace(/[/.]/g, "-"));
    mkdirSync(folder, { recursive: true });
    transcript = path.join(folder, `${SESSION}.jsonl`);
    // The turn's own prompt, already written when anything is typed mid-turn.
    append({ type: "user", message: { role: "user", content: "Run the slow command" } });
    ptySessionMock.sendText.mockClear().mockResolvedValue(undefined);
    ptySessionMock.sendKey.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedClaudeDir;
    rmSync(claudeDir, { recursive: true, force: true });
  });

  function append(entry: Record<string, unknown>): void {
    appendFileSync(transcript, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
  }

  const absorbed = (prompt: string) => ({
    type: "attachment",
    attachment: { type: "queued_command", prompt, commandMode: "prompt", origin: { kind: "human" } },
  });
  const opened = (content: string, promptId: string) => ({ type: "user", promptId, message: { role: "user", content } });

  async function makeRuntime() {
    let handler: SessionHookHandler | null = null;
    const router = {
      register: vi.fn((_sessionId: string, h: SessionHookHandler) => {
        handler = h;
        return "mock-token";
      }),
      unregister: vi.fn(),
      getUrl: vi.fn(() => "http://localhost:9999/hook"),
    } as unknown as HookRouter;
    const events: ParsedEvent[] = [];
    const runtime = new PtyRuntime({
      sessionId: SESSION,
      cwd: CWD,
      cliSessionId: SESSION,
      hookRouter: router,
      onEvents: (batch) => events.push(...batch),
      onError: () => {},
      onExit: () => {},
    });
    await runtime.start();
    const hooks = () => handler as unknown as Required<SessionHookHandler>;
    return { runtime, hooks, events };
  }

  /** A turn under way (prompt id p1) with "also this" typed into it and queued. */
  async function withQueuedMessage(text = "also this") {
    const made = await makeRuntime();
    made.hooks().onUserPromptSubmit({ prompt: "Run the slow command", prompt_id: "p1" });
    const sent = made.runtime.sendMidTurnText(text);
    await vi.waitFor(() => expect(ptySessionMock.sendText).toHaveBeenCalledWith(text));
    made.hooks().onUserPromptSubmit({ prompt: text, prompt_id: "p1" });
    expect(await sent).toBe(true);
    made.events.length = 0;
    return made;
  }

  const continues = (events: ParsedEvent[]) => events.some((e) => e.type === "system_message" && e.text === TURN_CONTINUES);
  const idles = (events: ParsedEvent[]) => events.filter((e) => e.type === "message_done");

  it("takes a message only while a turn is under way and nothing waits on the user", async () => {
    const { runtime, hooks } = await makeRuntime();
    expect(runtime.canTakeMidTurnMessage()).toBe(false);

    hooks().onUserPromptSubmit({ prompt: "Run the slow command", prompt_id: "p1" });
    expect(runtime.canTakeMidTurnMessage()).toBe(true);

    // A rendered permission dialog would be answered by typed keys.
    hooks().onNotification({ message: "Claude needs your permission to use Write", notification_type: "permission" });
    expect(runtime.canTakeMidTurnMessage()).toBe(false);
    expect(await runtime.sendMidTurnText("too soon")).toBe(false);
    expect(ptySessionMock.sendText).not.toHaveBeenCalled();
  });

  it("does not take a message while an ordinary send is still confirming", async () => {
    const { runtime, hooks } = await makeRuntime();
    hooks().onUserPromptSubmit({ prompt: "Run the slow command", prompt_id: "p1" });
    hooks().onStop({ prompt_id: "p1" });
    expect(runtime.canTakeMidTurnMessage()).toBe(false);

    void runtime.sendUserText("next turn");
    await vi.waitFor(() => expect(ptySessionMock.sendText).toHaveBeenCalledWith("next turn"));
    // Its UserPromptSubmit would be taken for the mid-turn message's.
    expect(runtime.canTakeMidTurnMessage()).toBe(false);
    hooks().onUserPromptSubmit({ prompt: "next turn", prompt_id: "p2" });
    await vi.waitFor(() => expect(runtime.canTakeMidTurnMessage()).toBe(true));
  });

  it("treats the message's UserPromptSubmit as joining the queue, not as a new turn", async () => {
    const { runtime, hooks, events } = await makeRuntime();
    hooks().onUserPromptSubmit({ prompt: "Run the slow command", prompt_id: "p1" });
    events.length = 0;

    const sent = runtime.sendMidTurnText("also this");
    await vi.waitFor(() => expect(ptySessionMock.sendText).toHaveBeenCalledWith("also this"));
    hooks().onUserPromptSubmit({ prompt: "also this", prompt_id: "p1" });

    expect(await sent).toBe(true);
    expect(runtime.holdsMidTurnMessages).toBe(true);
    expect(events).toEqual([]);
  });

  it("types one message at a time", async () => {
    const { runtime, hooks } = await makeRuntime();
    hooks().onUserPromptSubmit({ prompt: "Run the slow command", prompt_id: "p1" });

    const first = runtime.sendMidTurnText("one");
    const second = runtime.sendMidTurnText("two");
    await vi.waitFor(() => expect(ptySessionMock.sendText).toHaveBeenCalledWith("one"));
    expect(ptySessionMock.sendText).not.toHaveBeenCalledWith("two");

    hooks().onUserPromptSubmit({ prompt: "one", prompt_id: "p1" });
    expect(await first).toBe(true);
    await vi.waitFor(() => expect(ptySessionMock.sendText).toHaveBeenCalledWith("two"));
    hooks().onUserPromptSubmit({ prompt: "two", prompt_id: "p1" });
    expect(await second).toBe(true);
  });

  it("gives a message up when the CLI never reports it, and does not retype it", async () => {
    const { runtime, hooks } = await makeRuntime();
    hooks().onUserPromptSubmit({ prompt: "Run the slow command", prompt_id: "p1" });
    vi.useFakeTimers();

    const sent = runtime.sendMidTurnText("lost");
    await vi.advanceTimersByTimeAsync(5000);

    expect(await sent).toBe(false);
    expect(ptySessionMock.sendText).toHaveBeenCalledTimes(1);
    expect(runtime.holdsMidTurnMessages).toBe(false);
  });

  it("counts a message as queued when its hook is lost but the transcript logs the enqueue", async () => {
    const { runtime, hooks } = await makeRuntime();
    hooks().onUserPromptSubmit({ prompt: "Run the slow command", prompt_id: "p1" });
    vi.useFakeTimers();

    const sent = runtime.sendMidTurnText("hook lost");
    await vi.advanceTimersByTimeAsync(0);
    append({ type: "queue-operation", operation: "enqueue", content: "hook lost" });
    await vi.advanceTimersByTimeAsync(5000);

    expect(await sent).toBe(true);
    expect(runtime.holdsMidTurnMessages).toBe(true);
  });

  it("lets the turn end when the message was handed over with a tool result", async () => {
    const { runtime, hooks, events } = await withQueuedMessage();
    append(absorbed("also this"));

    hooks().onStop({ prompt_id: "p1", last_assistant_message: "Done." });

    expect(continues(events)).toBe(false);
    expect(runtime.holdsMidTurnMessages).toBe(false);
    expect(runtime.canTakeMidTurnMessage()).toBe(false);
  });

  it("keeps the session working when the turn ends with the message still queued", async () => {
    const { runtime, hooks, events } = await withQueuedMessage();
    vi.useFakeTimers();

    hooks().onStop({ prompt_id: "p1", last_assistant_message: "First answer." });
    expect(continues(events)).toBe(true);
    // The CLI opens a turn for it straight away.
    append({ type: "queue-operation", operation: "dequeue" });
    append(opened("also this", "p2"));
    await vi.advanceTimersByTimeAsync(6000);

    // Nothing let it go idle: that turn's own Stop will.
    expect(idles(events)).toHaveLength(1);
    expect(runtime.holdsMidTurnMessages).toBe(false);

    events.length = 0;
    hooks().onStop({ prompt_id: "p2", last_assistant_message: "Follow-up answer." });
    expect(continues(events)).toBe(false);
  });

  it("ends the turn that took the message up even when its Stop beats the transcript", async () => {
    const { runtime, hooks, events } = await withQueuedMessage();
    hooks().onStop({ prompt_id: "p1" });
    expect(continues(events)).toBe(true);
    events.length = 0;

    // A later turn's Stop: the queue went into that turn, written or not.
    hooks().onStop({ prompt_id: "p2" });
    expect(continues(events)).toBe(false);
    expect(runtime.holdsMidTurnMessages).toBe(false);
  });

  it("goes idle once the transcript shows the message was read in the turn that ended", async () => {
    const { runtime, hooks, events } = await withQueuedMessage();
    vi.useFakeTimers();

    // The Stop arrives before the CLI has written the handover.
    hooks().onStop({ prompt_id: "p1" });
    expect(continues(events)).toBe(true);
    append(absorbed("also this"));
    await vi.advanceTimersByTimeAsync(300);

    expect(idles(events)).toHaveLength(2);
    expect(idles(events)[1].message?.content).toBe("");
    expect(runtime.holdsMidTurnMessages).toBe(false);
  });

  it("goes idle when no turn for the message shows up in time", async () => {
    const { runtime, hooks, events } = await withQueuedMessage();
    vi.useFakeTimers();

    hooks().onStop({ prompt_id: "p1" });
    await vi.advanceTimersByTimeAsync(4000);
    expect(idles(events)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);

    expect(idles(events)).toHaveLength(2);
    expect(runtime.holdsMidTurnMessages).toBe(false);
    expect(runtime.canTakeMidTurnMessage()).toBe(false);
  });

  it("does not take an earlier identical message for this one", async () => {
    // "Run the slow command" was written before it was typed again.
    const { runtime, hooks, events } = await withQueuedMessage("Run the slow command");
    hooks().onStop({ prompt_id: "p1" });
    expect(continues(events)).toBe(true);
    expect(runtime.holdsMidTurnMessages).toBe(true);
  });

  it("keeps working after Esc while the CLI takes the message up", async () => {
    const { runtime, hooks, events } = await withQueuedMessage();
    vi.useFakeTimers();

    runtime.interrupt();
    expect(ptySessionMock.sendKey).toHaveBeenCalledWith("\x1b");
    expect(runtime.holdsMidTurnMessages).toBe(true);
    append(opened("also this", "p2"));
    await vi.advanceTimersByTimeAsync(6000);
    expect(idles(events)).toHaveLength(0);

    hooks().onStop({ prompt_id: "p2" });
    expect(continues(events)).toBe(false);
    expect(idles(events)).toHaveLength(1);
  });

  it("lets Esc end the session's work when the message had already been read", async () => {
    const { runtime } = await withQueuedMessage();
    append(absorbed("also this"));

    runtime.interrupt();

    expect(runtime.holdsMidTurnMessages).toBe(false);
    expect(runtime.canTakeMidTurnMessage()).toBe(false);
  });

  it("forgets held messages when the turn fails or the process is killed", async () => {
    const failed = await withQueuedMessage();
    failed.hooks().onStopFailure({ error_type: "server_error", error_message: "Overloaded" });
    expect(failed.runtime.holdsMidTurnMessages).toBe(false);

    const killed = await withQueuedMessage();
    await killed.runtime.kill();
    expect(killed.runtime.holdsMidTurnMessages).toBe(false);
  });
});
