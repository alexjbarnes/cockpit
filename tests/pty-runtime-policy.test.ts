// A requested bypass that does not take effect, as seen from the PTY runtime
// (discovered live 2026-08-08): the CLI silently runs in default mode despite
// --permission-mode bypassPermissions, and frontier models refuse a
// PermissionRequest-hook allow for self-modifying writes, hanging on a
// TUI-only dialog cockpit can't see. These tests pin the divergence detectors
// staying SILENT in the chat (cockpit answers the prompts, so the user has
// nothing to act on) and the Notification-hook dialog rescue with its keystroke
// answer path.
import { describe, expect, it, vi } from "vitest";
import type { ParsedEvent } from "@/server/event-parser";
import { PtyRuntime } from "@/server/pty-runtime";

vi.mock("@/server/debug-logger", () => ({
  logDiag: vi.fn(),
  logRawLine: vi.fn(),
  debugLog: vi.fn(),
  isDebugEnabled: () => false,
}));

vi.mock("@/server/pty-session", () => ({
  PtySession: class {
    pid = 4321;
    start() {
      return Promise.resolve();
    }
    sendText() {
      return Promise.resolve();
    }
    kill() {}
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

function makeRuntime(expected: "default" | "plan" | "bypassPermissions") {
  const events: ParsedEvent[] = [];
  const runtime = new PtyRuntime({
    sessionId: "s-policy-test",
    cwd: "/tmp",
    cliSessionId: "cli-1",
    hookRouter: { register: vi.fn(), unregister: vi.fn() } as never,
    onEvents: (evs) => events.push(...evs),
    onError: () => {},
    onExit: () => {},
    expectedPermissionMode: expected,
  });
  return { runtime, events };
}

function divergenceWarnings(events: ParsedEvent[]): ParsedEvent[] {
  return events.filter((e) => e.type === "system_message" && /requested bypass did not take effect/i.test(e.text ?? ""));
}

describe("permission-mode divergence stays out of the chat", () => {
  // The banner used to be emitted as a system_message on every affected
  // session. Since cockpit answers the resulting prompts itself, it told the
  // user about something they could not act on, so it is a debug-log note now.
  it("emits nothing when a hook payload reports default under an intended bypass", () => {
    const { runtime, events } = makeRuntime("bypassPermissions");
    const handler = (runtime as never as { buildHandler(): Record<string, (p: Record<string, unknown>) => unknown> }).buildHandler();

    handler.onUserPromptSubmit({ permission_mode: "default", prompt: "hi" });
    handler.onPreToolUse({ permission_mode: "default", tool_name: "Bash", tool_input: {} });

    expect(divergenceWarnings(events), "no banner, whatever the payload says").toHaveLength(0);
    expect(events.filter((e) => e.type === "system_message" && /bypass/i.test(e.text ?? ""))).toHaveLength(0);
  });

  it("emits nothing for the boot banner either", () => {
    const { runtime, events } = makeRuntime("bypassPermissions");
    (runtime as never as { scanForErrors(chunk: string): void }).scanForErrors(
      "some output\nBypass permissions mode was disabled by settings\nmore output",
    );
    expect(events.filter((e) => e.type === "system_message")).toHaveLength(0);
  });
});

describe("TUI-only permission dialog rescue", () => {
  function fire(events: ParsedEvent[], runtime: PtyRuntime): ParsedEvent | undefined {
    const handler = (runtime as never as { buildHandler(): Record<string, (p: Record<string, unknown>) => unknown> }).buildHandler();
    handler.onPreToolUse({ permission_mode: "default", tool_name: "Write", tool_input: { file_path: "/x/.claude/skills/a/SKILL.md" } });
    handler.onNotification({ message: "Claude needs your permission to use Write", notification_type: "permission" });
    return events.find((e) => e.type === "permission_request");
  }

  it("turns the needs-your-permission notification into an interactive-only request naming the last tool", () => {
    const { runtime, events } = makeRuntime("bypassPermissions");
    const req = fire(events, runtime);
    expect(req).toBeDefined();
    expect(req?.interactiveOnly).toBe(true);
    expect(req?.requestId?.startsWith("tui-")).toBe(true);
    expect(req?.toolName).toBe("Write");
    expect(req?.rawToolInput).toEqual({ file_path: "/x/.claude/skills/a/SKILL.md" });
  });

  it("answers the dialog with keystrokes: '1' for allow, Esc for deny", () => {
    const { runtime, events } = makeRuntime("bypassPermissions");
    const req = fire(events, runtime);
    const sendKey = vi.fn();
    (runtime as never as { pty: unknown }).pty = { sendKey } as never;

    expect(runtime.notifyPermissionDecision(req?.requestId as string, { behavior: "allow" })).toBe(true);
    expect(sendKey).toHaveBeenCalledWith("1");

    const second = makeRuntime("bypassPermissions");
    const req2 = fire(second.events, second.runtime);
    const sendKey2 = vi.fn();
    (second.runtime as never as { pty: unknown }).pty = { sendKey: sendKey2 } as never;
    expect(second.runtime.notifyPermissionDecision(req2?.requestId as string, { behavior: "deny", message: "no" })).toBe(true);
    expect(sendKey2).toHaveBeenCalledWith("\x1b");
  });

  it("ignores unrelated notifications", () => {
    const { runtime, events } = makeRuntime("bypassPermissions");
    const handler = (runtime as never as { buildHandler(): Record<string, (p: Record<string, unknown>) => unknown> }).buildHandler();
    handler.onNotification({ message: "Claude is waiting for your input" });
    expect(events.find((e) => e.type === "permission_request")).toBeUndefined();
  });

  // Observed live 2026-08-12 with AskUserQuestion: the PermissionRequest hook
  // raised a request, then the notification hook raised a second one for the
  // same tool six seconds later, and the two ids meant the client's per-id
  // dedupe let both through — one question rendered as two identical cards.
  // The rescue is only for a dialog cockpit has no hook channel for, so a
  // request still waiting on its hook resolver is proof this is not that.
  it("does not raise a second request while a hook request for the same tool is pending", () => {
    const { runtime, events } = makeRuntime("default");
    const handler = (runtime as never as { buildHandler(): Record<string, (p: Record<string, unknown>) => unknown> }).buildHandler();
    const toolInput = { questions: [{ question: "Which?", header: "Pick", options: [] }] };

    handler.onPreToolUse({ permission_mode: "default", tool_name: "AskUserQuestion", tool_input: toolInput });
    handler.onPermissionRequest({ permission_mode: "default", tool_name: "AskUserQuestion", tool_input: toolInput });
    handler.onNotification({ message: "Claude needs your permission to use AskUserQuestion", notification_type: "permission" });

    const requests = events.filter((e) => e.type === "permission_request");
    expect(requests).toHaveLength(1);
    expect(requests[0].requestId?.startsWith("tui-")).toBe(false);
  });

  it("still rescues the dialog once the hook request has been answered", () => {
    const { runtime, events } = makeRuntime("default");
    const handler = (runtime as never as { buildHandler(): Record<string, (p: Record<string, unknown>) => unknown> }).buildHandler();
    const preToolUse = { permission_mode: "default", tool_name: "Write", tool_input: { file_path: "/x/.claude/skills/a/SKILL.md" } };

    handler.onPreToolUse(preToolUse);
    handler.onPermissionRequest(preToolUse);
    const hookRequest = events.find((e) => e.type === "permission_request");
    runtime.notifyPermissionDecision(hookRequest?.requestId as string, { behavior: "allow" });

    // The CLI refused the hook's allow and is sitting on its own dialog.
    handler.onNotification({ message: "Claude needs your permission to use Write", notification_type: "permission" });

    const rescued = events.filter((e) => e.type === "permission_request").at(-1);
    expect(rescued?.requestId?.startsWith("tui-")).toBe(true);
    expect(rescued?.interactiveOnly).toBe(true);
  });
});

// Status and the background-work indicator, both driven by the CLI's own
// `background_tasks` list rather than inferred from the Subagent hooks.
//
// Measured against the real CLI (harness probe, 2026-08-13) in this order:
//   SubagentStart                          agent launched
//   Stop, background_tasks:[{running}]     parent's turn ends, agent still going
//   SubagentStop, background_tasks:[{running}]   fires ~90ms later and LIES
//   Stop, background_tasks:[]              genuine completion, much later
// and live on a real box the launched agent's own stop never arrived at all,
// while stops turned up for ids that never started. So a stop proves nothing;
// only the list does.
describe("background work: status gate and reported count", () => {
  function handlerFor(runtime: PtyRuntime) {
    return (runtime as never as { buildHandler(): Record<string, (p: Record<string, unknown>) => unknown> }).buildHandler();
  }

  const statusSignals = (events: ParsedEvent[]) => events.filter((e) => e.type === "system_message" && e.text === "__tool_use_start");
  const toolStarts = (events: ParsedEvent[]) => events.filter((e) => e.type === "tool_use_start");
  const counts = (events: ParsedEvent[]) =>
    events.filter((e) => e.type === "system_message" && e.text?.startsWith("__agents::")).map((e) => e.text);

  const preToolUse = { permission_mode: "default", tool_name: "Bash", tool_input: { command: "echo hi" } };
  const task = (id: string, status = "running") => ({ id, status, agent_type: "general-purpose", description: "work" });

  it("mid-turn, a tool call always drives status, agent running or not", () => {
    const { runtime, events } = makeRuntime("default");
    const handler = handlerFor(runtime);

    handler.onPreToolUse(preToolUse);
    expect(statusSignals(events)).toHaveLength(1);

    handler.onSubagentStart({ agent_id: "agent-1", agent_type: "general-purpose" });
    events.length = 0;
    handler.onPreToolUse(preToolUse);
    expect(statusSignals(events), "the turn has not ended, so this is the main thread working").toHaveLength(1);
  });

  it("suppresses the status signal after the turn ends while work is still listed", () => {
    const { runtime, events } = makeRuntime("default");
    const handler = handlerFor(runtime);

    handler.onSubagentStart({ agent_id: "agent-1", agent_type: "general-purpose" });
    handler.onStop({ background_tasks: [task("agent-1")] });

    events.length = 0;
    handler.onPreToolUse(preToolUse);
    expect(statusSignals(events), "the agent's tool call is not the user's turn resuming").toHaveLength(0);
    expect(toolStarts(events), "the tool itself still renders").toHaveLength(1);
  });

  it("ignores a SubagentStop whose own payload still lists the agent running", () => {
    const { runtime, events } = makeRuntime("default");
    const handler = handlerFor(runtime);

    handler.onSubagentStart({ agent_id: "agent-1" });
    handler.onStop({ background_tasks: [task("agent-1")] });
    // The real sequence: the stop arrives ~90ms in, carrying a list that still
    // says running. Believing the stop released the gate and blanked the dot.
    handler.onSubagentStop({ agent_id: "agent-1", background_tasks: [task("agent-1")] });

    events.length = 0;
    handler.onPreToolUse(preToolUse);
    expect(statusSignals(events)).toHaveLength(0);
    expect(counts(events), "nothing changed, so nothing is re-reported").toHaveLength(0);
  });

  it("releases the gate when the list finally comes back empty", () => {
    const { runtime, events } = makeRuntime("default");
    const handler = handlerFor(runtime);

    handler.onSubagentStart({ agent_id: "agent-1" });
    handler.onStop({ background_tasks: [task("agent-1")] });
    handler.onSubagentStop({ agent_id: "agent-1", background_tasks: [] });

    events.length = 0;
    handler.onPreToolUse(preToolUse);
    expect(statusSignals(events)).toHaveLength(1);
  });

  it("ignores a stop for an agent that never started here", () => {
    const { runtime, events } = makeRuntime("default");
    const handler = handlerFor(runtime);

    handler.onSubagentStart({ agent_id: "agent-1" });
    handler.onStop({ background_tasks: [task("agent-1")] });
    // Live: the CLI's internal agents report stops on the parent session.
    handler.onSubagentStop({ agent_id: "internal-x", background_tasks: [task("agent-1")] });

    events.length = 0;
    handler.onPreToolUse(preToolUse);
    expect(statusSignals(events)).toHaveLength(0);
  });

  it("a payload with no task list leaves the count alone", () => {
    const { runtime, events } = makeRuntime("default");
    const handler = handlerFor(runtime);

    handler.onSubagentStart({ agent_id: "agent-1" });
    handler.onStop({ background_tasks: [task("agent-1")] });
    events.length = 0;
    // Not every hook carries background_tasks; absence is not emptiness.
    handler.onSubagentStop({ agent_id: "agent-1" });

    handler.onPreToolUse(preToolUse);
    expect(statusSignals(events)).toHaveLength(0);
    expect(counts(events)).toHaveLength(0);
  });

  it("reports the count on launch, on change, and never twice for the same value", () => {
    const { runtime, events } = makeRuntime("default");
    const handler = handlerFor(runtime);

    handler.onSubagentStart({ agent_id: "agent-1" });
    handler.onSubagentStart({ agent_id: "agent-2" });
    handler.onSubagentStart({ agent_id: "agent-2" });
    handler.onStop({ background_tasks: [task("agent-1"), task("agent-2")] });
    handler.onStop({ background_tasks: [task("agent-1"), task("agent-2", "completed")] });
    handler.onStop({ background_tasks: [] });

    expect(counts(events)).toEqual(["__agents::1", "__agents::2", "__agents::1", "__agents::0"]);
  });

  it("keeps the count across a new user turn, but reopens the spinner for it", () => {
    const { runtime, events } = makeRuntime("default");
    const handler = handlerFor(runtime);

    handler.onSubagentStart({ agent_id: "agent-1" });
    handler.onStop({ background_tasks: [task("agent-1")] });
    events.length = 0;

    // The user sends a message while the agent works on.
    handler.onUserPromptSubmit({ permission_mode: "default", prompt: "meanwhile" });
    expect(events.filter((e) => e.type === "system_message" && e.text === "__turn_start")).toHaveLength(1);
    expect(counts(events), "background work outlives the turn that launched it").toHaveLength(0);

    events.length = 0;
    handler.onPreToolUse(preToolUse);
    expect(statusSignals(events), "this turn's tool calls are the user's").toHaveLength(1);
  });
});
