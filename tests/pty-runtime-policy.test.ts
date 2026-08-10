// A requested bypass that does not take effect, as seen from the PTY runtime
// (discovered live 2026-08-08): the CLI silently runs in default mode despite
// --permission-mode bypassPermissions, and frontier models refuse a
// PermissionRequest-hook allow for self-modifying writes, hanging on a
// TUI-only dialog cockpit can't see. These tests pin the three detectors:
// hook-payload permission_mode divergence, the boot banner, and the
// Notification-hook dialog rescue with its keystroke answer path.
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

describe("permission-mode divergence detection", () => {
  it("warns once when a hook payload reports default under an intended bypass", () => {
    const { runtime, events } = makeRuntime("bypassPermissions");
    const handler = (runtime as never as { buildHandler(): Record<string, (p: Record<string, unknown>) => unknown> }).buildHandler();

    handler.onUserPromptSubmit({ permission_mode: "default", prompt: "hi" });
    expect(divergenceWarnings(events)).toHaveLength(1);

    // Once per process — repeated payloads stay quiet.
    handler.onUserPromptSubmit({ permission_mode: "default", prompt: "again" });
    handler.onPreToolUse({ permission_mode: "default", tool_name: "Bash", tool_input: {} });
    expect(divergenceWarnings(events)).toHaveLength(1);
  });

  it("stays quiet when modes agree, when no mode was expected, and in plan mode", () => {
    const agree = makeRuntime("bypassPermissions");
    (agree.runtime as never as { buildHandler(): Record<string, (p: Record<string, unknown>) => unknown> })
      .buildHandler()
      .onUserPromptSubmit({ permission_mode: "bypassPermissions", prompt: "hi" });
    expect(divergenceWarnings(agree.events)).toHaveLength(0);

    const dflt = makeRuntime("default");
    (dflt.runtime as never as { buildHandler(): Record<string, (p: Record<string, unknown>) => unknown> })
      .buildHandler()
      .onUserPromptSubmit({ permission_mode: "default", prompt: "hi" });
    expect(divergenceWarnings(dflt.events)).toHaveLength(0);

    const plan = makeRuntime("plan");
    (plan.runtime as never as { buildHandler(): Record<string, (p: Record<string, unknown>) => unknown> })
      .buildHandler()
      .onUserPromptSubmit({ permission_mode: "plan", prompt: "hi" });
    expect(divergenceWarnings(plan.events)).toHaveLength(0);
  });

  it("detects the boot banner before any hook fires", () => {
    const { runtime, events } = makeRuntime("bypassPermissions");
    (runtime as never as { scanForErrors(chunk: string): void }).scanForErrors(
      "some output\nBypass permissions mode was disabled by settings\nmore output",
    );
    expect(divergenceWarnings(events)).toHaveLength(1);
    // Banner sticks around in the rolling buffer; must not re-warn.
    (runtime as never as { scanForErrors(chunk: string): void }).scanForErrors("tail");
    expect(divergenceWarnings(events)).toHaveLength(1);
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
});

// A background subagent keeps calling tools after its parent's turn has ended.
// Every PreToolUse emits `__tool_use_start`, which drives the session back to
// "running" — so the spinner restarted on a session that was idle and waiting
// for the user. A subagent's PreToolUse is indistinguishable from the main
// thread's (probed against the real CLI: same session_id, same
// transcript_path, no agent id), so the agent's lifetime is the only signal.
describe("status while a subagent is running", () => {
  function handlerFor(runtime: PtyRuntime) {
    return (runtime as never as { buildHandler(): Record<string, (p: Record<string, unknown>) => unknown> }).buildHandler();
  }

  const statusSignals = (events: ParsedEvent[]) => events.filter((e) => e.type === "system_message" && e.text === "__tool_use_start");
  const toolStarts = (events: ParsedEvent[]) => events.filter((e) => e.type === "tool_use_start");

  it("suppresses the status signal while an agent is active, and restores it after", () => {
    const { runtime, events } = makeRuntime("default");
    const handler = handlerFor(runtime);
    const preToolUse = { permission_mode: "default", tool_name: "Bash", tool_input: { command: "echo hi" } };

    handler.onPreToolUse(preToolUse);
    expect(statusSignals(events), "no agent running: the main thread drives status as before").toHaveLength(1);

    handler.onSubagentStart({ agent_id: "agent-1", agent_type: "general-purpose" });
    events.length = 0;
    handler.onPreToolUse(preToolUse);
    expect(statusSignals(events), "agent running: a tool call is not evidence the turn resumed").toHaveLength(0);
    expect(toolStarts(events), "the tool itself still renders").toHaveLength(1);

    handler.onSubagentStop({ agent_id: "agent-1", agent_type: "general-purpose" });
    events.length = 0;
    handler.onPreToolUse(preToolUse);
    expect(statusSignals(events), "agent finished: status recovery works again").toHaveLength(1);
  });

  it("waits for every agent to stop before restoring it", () => {
    const { runtime, events } = makeRuntime("default");
    const handler = handlerFor(runtime);
    handler.onSubagentStart({ agent_id: "agent-1" });
    handler.onSubagentStart({ agent_id: "agent-2" });
    handler.onSubagentStop({ agent_id: "agent-1" });

    events.length = 0;
    handler.onPreToolUse({ permission_mode: "default", tool_name: "Bash", tool_input: {} });
    expect(statusSignals(events)).toHaveLength(0);

    handler.onSubagentStop({ agent_id: "agent-2" });
    events.length = 0;
    handler.onPreToolUse({ permission_mode: "default", tool_name: "Bash", tool_input: {} });
    expect(statusSignals(events)).toHaveLength(1);
  });

  it("ignores a subagent payload with no agent id rather than blocking status forever", () => {
    const { runtime, events } = makeRuntime("default");
    const handler = handlerFor(runtime);
    handler.onSubagentStart({ agent_type: "general-purpose" });

    events.length = 0;
    handler.onPreToolUse({ permission_mode: "default", tool_name: "Bash", tool_input: {} });
    expect(statusSignals(events)).toHaveLength(1);
  });
});
