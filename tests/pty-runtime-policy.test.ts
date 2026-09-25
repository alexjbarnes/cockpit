// The PTY runtime's view of permissions. The CLI reports the mode it is in on
// every hook payload, which need not be the one cockpit spawned it in: cockpit
// applies bypass itself by keeping the CLI in manual, and answers every prompt
// that mode raises. These tests pin that reported mode reaching the session as
// `__cli_perm_mode::` and never as chat text, and the Notification-hook rescue
// of TUI-only dialogs (frontier models refuse a PermissionRequest-hook allow
// for self-modifying writes) with its keystroke answer path.
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

// Whether an escape can happen depends on settings files; here it is just the
// session's own switch.
vi.mock("@/server/claude-sandbox-rules", () => ({
  sandboxEscapePossible: vi.fn(async (_cwd: string, enabled: boolean) => enabled),
}));

function makeRuntime(expected: "manual" | "plan" | "auto") {
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

function cliModeReports(events: ParsedEvent[]): string[] {
  return events
    .filter((e) => e.type === "system_message" && (e.text ?? "").startsWith("__cli_perm_mode::"))
    .map((e) => (e.text as string).slice("__cli_perm_mode::".length));
}

describe("the CLI's real permission mode", () => {
  function handlerOf(runtime: PtyRuntime) {
    return (runtime as never as { buildHandler(): Record<string, (p: Record<string, unknown>) => unknown> }).buildHandler();
  }

  it("reports the mode from SessionStart, before any message is sent", () => {
    const { runtime, events } = makeRuntime("manual");
    handlerOf(runtime).onSessionStart({ permission_mode: "manual", source: "startup" });
    expect(cliModeReports(events)).toEqual(["manual"]);
  });

  // Spawned for manual (cockpit's bypass), and reporting something else.
  it("reports each change once, whichever hook carries it", () => {
    const { runtime, events } = makeRuntime("manual");
    const handler = handlerOf(runtime);
    handler.onSessionStart({ permission_mode: "manual" });
    handler.onUserPromptSubmit({ permission_mode: "manual", prompt: "hi" });
    handler.onPreToolUse({ permission_mode: "auto", tool_name: "Bash", tool_input: {} });
    handler.onStop({ permission_mode: "auto" });
    expect(cliModeReports(events)).toEqual(["manual", "auto"]);
  });

  it("ignores a payload that carries no mode", () => {
    const { runtime, events } = makeRuntime("manual");
    handlerOf(runtime).onSessionStart({ source: "startup" });
    expect(cliModeReports(events)).toEqual([]);
  });

  it("never puts the mode in the chat as text", () => {
    const { runtime, events } = makeRuntime("manual");
    const handler = handlerOf(runtime);
    handler.onSessionStart({ permission_mode: "auto" });
    handler.onPreToolUse({ permission_mode: "auto", tool_name: "Bash", tool_input: {} });
    const visible = events.filter((e) => e.type === "system_message" && !(e.text ?? "").startsWith("__"));
    expect(visible).toHaveLength(0);
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
    const { runtime, events } = makeRuntime("manual");
    const req = fire(events, runtime);
    expect(req).toBeDefined();
    expect(req?.interactiveOnly).toBe(true);
    expect(req?.requestId?.startsWith("tui-")).toBe(true);
    expect(req?.toolName).toBe("Write");
    expect(req?.rawToolInput).toEqual({ file_path: "/x/.claude/skills/a/SKILL.md" });
  });

  it("answers the dialog with keystrokes: '1' for allow, Esc for deny", () => {
    const { runtime, events } = makeRuntime("manual");
    const req = fire(events, runtime);
    const sendKey = vi.fn();
    (runtime as never as { pty: unknown }).pty = { sendKey } as never;

    expect(runtime.notifyPermissionDecision(req?.requestId as string, { behavior: "allow" })).toBe(true);
    expect(sendKey).toHaveBeenCalledWith("1");

    const second = makeRuntime("manual");
    const req2 = fire(second.events, second.runtime);
    const sendKey2 = vi.fn();
    (second.runtime as never as { pty: unknown }).pty = { sendKey: sendKey2 } as never;
    expect(second.runtime.notifyPermissionDecision(req2?.requestId as string, { behavior: "deny", message: "no" })).toBe(true);
    expect(sendKey2).toHaveBeenCalledWith("\x1b");
  });

  it("ignores unrelated notifications", () => {
    const { runtime, events } = makeRuntime("manual");
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
    const { runtime, events } = makeRuntime("manual");
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
    const { runtime, events } = makeRuntime("manual");
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
    const { runtime, events } = makeRuntime("manual");
    const handler = handlerFor(runtime);

    handler.onPreToolUse(preToolUse);
    expect(statusSignals(events)).toHaveLength(1);

    handler.onSubagentStart({ agent_id: "agent-1", agent_type: "general-purpose" });
    events.length = 0;
    handler.onPreToolUse(preToolUse);
    expect(statusSignals(events), "the turn has not ended, so this is the main thread working").toHaveLength(1);
  });

  it("suppresses the status signal after the turn ends while work is still listed", () => {
    const { runtime, events } = makeRuntime("manual");
    const handler = handlerFor(runtime);

    handler.onSubagentStart({ agent_id: "agent-1", agent_type: "general-purpose" });
    handler.onStop({ background_tasks: [task("agent-1")] });

    events.length = 0;
    handler.onPreToolUse(preToolUse);
    expect(statusSignals(events), "the agent's tool call is not the user's turn resuming").toHaveLength(0);
    expect(toolStarts(events), "the tool itself still renders").toHaveLength(1);
  });

  it("ignores a SubagentStop whose own payload still lists the agent running", () => {
    const { runtime, events } = makeRuntime("manual");
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
    const { runtime, events } = makeRuntime("manual");
    const handler = handlerFor(runtime);

    handler.onSubagentStart({ agent_id: "agent-1" });
    handler.onStop({ background_tasks: [task("agent-1")] });
    handler.onSubagentStop({ agent_id: "agent-1", background_tasks: [] });

    events.length = 0;
    handler.onPreToolUse(preToolUse);
    expect(statusSignals(events)).toHaveLength(1);
  });

  it("ignores a stop for an agent that never started here", () => {
    const { runtime, events } = makeRuntime("manual");
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
    const { runtime, events } = makeRuntime("manual");
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
    const { runtime, events } = makeRuntime("manual");
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
    const { runtime, events } = makeRuntime("manual");
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

// The CLI's "Network request outside of sandbox" question is drawn in the
// terminal only: no PermissionRequest reaches cockpit and the command's
// connection waits on it. Screens as recorded from the real CLI (2.1.282),
// including a frame whose partial repaint dropped a letter from the host.
const NETWORK_DIALOG = [
  "Network request outside of sandbox",
  "Host: example.net",
  "Do you want to allow this connection?",
  "❯ 1. Yes",
  "2. Yes, and don't ask again for example.net",
  "3. No, and tell Claude what to do differently (esc)",
].join("\n");
const GARBLED_FRAME = "Network request outside of sandbox\nHost: exmple.net\nDo you want to alow this connectin?";
const OTHER_HOST_DIALOG = NETWORK_DIALOG.replaceAll("example.net", "other.example.org");

describe("the CLI's network access dialog", () => {
  type Internals = {
    buildHandler(): Record<string, (p: Record<string, unknown>) => unknown>;
    scanForErrors(chunk: string): void;
    blockingDialogOnScreen(): string | null;
    pty: unknown;
    ptyOutputBuffer: string;
  };

  function raise() {
    const { runtime, events } = makeRuntime("manual");
    const internals = runtime as never as Internals;
    const handler = internals.buildHandler();
    handler.onPreToolUse({ permission_mode: "default", tool_name: "Bash", tool_input: { command: "curl https://example.net/" } });
    internals.scanForErrors(NETWORK_DIALOG);
    internals.scanForErrors(GARBLED_FRAME);
    internals.scanForErrors(NETWORK_DIALOG);
    handler.onNotification({ message: "A sandboxed command needs network access", notification_type: "permission_prompt" });
    const sendKey = vi.fn();
    internals.pty = { sendKey };
    return { runtime, events, internals, sendKey, request: () => events.filter((e) => e.type === "permission_request").at(-1) };
  }

  it("raises it as a request for the host on screen, reading past a garbled frame", async () => {
    const { request } = raise();
    await vi.waitFor(() => expect(request()).toBeDefined());
    expect(request()).toMatchObject({
      toolName: "SandboxNetworkAccess",
      interactiveOnly: true,
      rawToolInput: { host: "example.net", command: "curl https://example.net/" },
    });
    expect(request()?.requestId?.startsWith("tui-")).toBe(true);
    expect(request()?.permissionSuggestions).toHaveLength(1);
  });

  it("answers with the dialog's own keys: 1 allows once, 2 allows always, Esc refuses", async () => {
    for (const [decision, opts, key] of [
      [{ behavior: "allow" }, undefined, "1"],
      [{ behavior: "allow" }, { always: true }, "2"],
      [{ behavior: "deny", message: "no" }, { always: true }, "\x1b"],
    ] as const) {
      const { runtime, sendKey, request } = raise();
      await vi.waitFor(() => expect(request()).toBeDefined());
      expect(runtime.notifyPermissionDecision(request()?.requestId as string, decision, opts)).toBe(true);
      expect(sendKey).toHaveBeenCalledWith(key);
    }
  });

  it("refuses a typed message while the dialog waits, and lets messages through once it is answered", async () => {
    const { runtime, internals, request } = raise();
    await vi.waitFor(() => expect(request()).toBeDefined());
    // Enter would pick "Yes", so typing into it would answer it.
    expect(internals.blockingDialogOnScreen()).toBe("Network request outside of sandbox");
    runtime.notifyPermissionDecision(request()?.requestId as string, { behavior: "deny", message: "no" });
    expect(internals.blockingDialogOnScreen()).toBeNull();
  });

  it("reads the dialog off the screen even without a pending request, until the prompt's footer is back", () => {
    const { runtime } = makeRuntime("manual");
    const internals = runtime as never as Internals;
    internals.scanForErrors(NETWORK_DIALOG);
    expect(internals.blockingDialogOnScreen()).toBe("Network request outside of sandbox");
    internals.scanForErrors("\n❯ \n⏸ manual mode on · ? for shortcuts · ← for agents");
    expect(internals.blockingDialogOnScreen()).toBeNull();
  });

  it("will not press yes on a dialog about another host, and raises the card again", async () => {
    const { runtime, internals, sendKey, events, request } = raise();
    await vi.waitFor(() => expect(request()).toBeDefined());
    const id = request()?.requestId as string;
    internals.ptyOutputBuffer = "";
    internals.scanForErrors(OTHER_HOST_DIALOG);

    expect(runtime.notifyPermissionDecision(id, { behavior: "allow" })).toBe(false);
    expect(sendKey).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === "permission_request" && e.requestId === id)).toHaveLength(2);
    expect(events.some((e) => e.type === "system_message" && (e.text ?? "").includes("different host"))).toBe(true);
  });

  it("raises nothing for a dialog Stop dismissed while its host was still being read", async () => {
    const { runtime, events } = makeRuntime("manual");
    const internals = runtime as never as Internals;
    internals.pty = { sendKey: vi.fn() };
    // Nothing on screen yet, so the runtime waits for the host to paint.
    internals.buildHandler().onNotification({ message: "A sandboxed command needs network access" });
    runtime.interrupt();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(events.find((e) => e.type === "permission_request")).toBeUndefined();
    // No phantom request is left holding every later message back.
    internals.ptyOutputBuffer = "";
    expect(internals.blockingDialogOnScreen()).toBeNull();
  });

  it("raises one card for a dialog the CLI notifies about twice", async () => {
    const { internals, events, request } = raise();
    await vi.waitFor(() => expect(request()).toBeDefined());
    internals.buildHandler().onNotification({ message: "A sandboxed command needs network access" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.filter((e) => e.type === "permission_request")).toHaveLength(1);
  });

  it("drops a deny meant for a host the screen is not asking about, pressing nothing", async () => {
    const { runtime, internals, sendKey, events, request } = raise();
    await vi.waitFor(() => expect(request()).toBeDefined());
    internals.ptyOutputBuffer = "";
    internals.scanForErrors(OTHER_HOST_DIALOG);

    // Esc would refuse the other host's request instead.
    expect(runtime.notifyPermissionDecision(request()?.requestId as string, { behavior: "deny", message: "no" })).toBe(true);
    expect(sendKey).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === "permission_request")).toHaveLength(1);
  });

  it("does not take a reply that merely quotes the dialog's question for the dialog", () => {
    const { runtime } = makeRuntime("manual");
    const internals = runtime as never as Internals;
    internals.scanForErrors('● The prompt asks "Do you want to allow this connection?" and offers three answers.');
    expect(internals.blockingDialogOnScreen()).toBeNull();
  });

  it("names no host when none can be read, rather than guessing", async () => {
    const { runtime, events } = makeRuntime("manual");
    const handler = (runtime as never as Internals).buildHandler();
    handler.onNotification({ message: "A sandboxed command needs network access" });
    await vi.waitFor(() => expect(events.find((e) => e.type === "permission_request")).toBeDefined(), { timeout: 2000 });
    expect(events.find((e) => e.type === "permission_request")?.rawToolInput).toEqual({});
  });
});

describe("a Bash call asking to leave the sandbox", () => {
  function runtimeWith(sandboxEnabled: boolean) {
    const runtime = new PtyRuntime({
      sessionId: "s-escape-test",
      cwd: "/tmp",
      cliSessionId: "cli-1",
      hookRouter: { register: vi.fn(), unregister: vi.fn() } as never,
      onEvents: () => {},
      onError: () => {},
      onExit: () => {},
      sandbox: { enabled: sandboxEnabled },
    });
    return (runtime as never as { buildHandler(): Record<string, (p: Record<string, unknown>) => unknown> }).buildHandler();
  }
  const escapeCall = { tool_name: "Bash", tool_input: { command: "npm test", dangerouslyDisableSandbox: true } };

  it("is answered ask, so the CLI prompts for it in every mode", async () => {
    const response = (await runtimeWith(true).onPreToolUse(escapeCall)) as { stdout: string; exitCode: number };
    expect(response.exitCode).toBe(0);
    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Runs outside the sandbox" },
    });
  });

  it("gets no answer when there is no sandbox to leave, and neither does an ordinary call", async () => {
    expect(await runtimeWith(false).onPreToolUse(escapeCall)).toBeUndefined();
    expect(await runtimeWith(true).onPreToolUse({ tool_name: "Bash", tool_input: { command: "npm test" } })).toBeUndefined();
    expect(await runtimeWith(true).onPreToolUse({ tool_name: "Read", tool_input: { dangerouslyDisableSandbox: true } })).toBeUndefined();
  });
});
