import { describe, expect, it } from "vitest";
import { newPermissionRequestId, translateHookEvent } from "@/server/hook-event-translator";

describe("translateHookEvent", () => {
  describe("PreToolUse", () => {
    it("maps a Read tool_use payload to tool_use_start with stringified input", () => {
      const events = translateHookEvent("PreToolUse", {
        tool_name: "Read",
        tool_use_id: "toolu_01ABC",
        tool_input: { file_path: "/etc/hosts" },
      });

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: "system_message", text: "__tool_use_start" });
      expect(events[1]).toEqual({
        type: "tool_use_start",
        toolName: "Read",
        toolId: "toolu_01ABC",
        toolInput: JSON.stringify({ file_path: "/etc/hosts" }),
      });
    });

    it("falls back to 'unknown' toolName and undefined toolId/empty toolInput when fields are missing", () => {
      const events = translateHookEvent("PreToolUse", {});

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: "system_message", text: "__tool_use_start" });
      expect(events[1]).toEqual({
        type: "tool_use_start",
        toolName: "unknown",
        toolId: undefined,
        toolInput: "",
      });
    });

    it("emits __permission_mode::plan system_message for EnterPlanMode tool", () => {
      const events = translateHookEvent("PreToolUse", {
        tool_name: "EnterPlanMode",
        tool_use_id: "toolu_plan",
        tool_input: {},
      });

      expect(events).toHaveLength(3);
      expect(events[0]).toEqual({ type: "system_message", text: "__tool_use_start" });
      expect(events[1]).toMatchObject({ type: "tool_use_start", toolName: "EnterPlanMode", toolId: "toolu_plan" });
      expect(events[2]).toEqual({
        type: "system_message",
        text: "__permission_mode::plan",
      });
    });
  });

  describe("PostToolUse", () => {
    it("extracts stdout/stderr from a Bash tool_response", () => {
      const events = translateHookEvent("PostToolUse", {
        tool_name: "Bash",
        tool_use_id: "toolu_02DEF",
        tool_input: { command: "echo hi" },
        tool_response: { stdout: "hi\n", stderr: "warn", interrupted: false },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "tool_result",
        toolId: "toolu_02DEF",
        toolOutput: "hi\n\nwarn",
        filePath: undefined,
      });
    });

    it("extracts content from a Read tool_response and propagates file_path", () => {
      const events = translateHookEvent("PostToolUse", {
        tool_name: "Read",
        tool_use_id: "toolu_03",
        tool_input: { file_path: "/tmp/foo.txt" },
        tool_response: { content: "file contents here" },
      });

      expect(events[0]).toEqual({
        type: "tool_result",
        toolId: "toolu_03",
        toolOutput: "file contents here",
        filePath: "/tmp/foo.txt",
      });
    });

    it("handles a string tool_response", () => {
      const events = translateHookEvent("PostToolUse", {
        tool_use_id: "toolu_04",
        tool_response: "raw string output",
      });

      expect(events[0].toolOutput).toBe("raw string output");
    });

    it("falls back to JSON.stringify for unknown object shapes", () => {
      const events = translateHookEvent("PostToolUse", {
        tool_use_id: "toolu_05",
        tool_response: { something: "weird", value: 42 },
      });

      expect(events[0].toolOutput).toBe(JSON.stringify({ something: "weird", value: 42 }));
    });

    it("returns empty toolOutput for null/missing response", () => {
      const events = translateHookEvent("PostToolUse", { tool_use_id: "toolu_06" });
      expect(events[0].toolOutput).toBe("");
    });

    it("picks filePath from filePath or path fields too", () => {
      const camel = translateHookEvent("PostToolUse", {
        tool_use_id: "t1",
        tool_input: { filePath: "/a" },
        tool_response: "",
      });
      expect(camel[0].filePath).toBe("/a");

      const plain = translateHookEvent("PostToolUse", {
        tool_use_id: "t2",
        tool_input: { path: "/b" },
        tool_response: "",
      });
      expect(plain[0].filePath).toBe("/b");
    });

    it("omits stderr when empty string", () => {
      const events = translateHookEvent("PostToolUse", {
        tool_use_id: "t",
        tool_response: { stdout: "out", stderr: "" },
      });
      expect(events[0].toolOutput).toBe("out");
    });

    it("emits __permission_mode::standard system_message for ExitPlanMode tool", () => {
      const events = translateHookEvent("PostToolUse", {
        tool_name: "ExitPlanMode",
        tool_use_id: "toolu_exit",
        tool_input: {},
        tool_response: { content: "plan submitted" },
      });

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("tool_result");
      expect(events[0]).toMatchObject({ toolId: "toolu_exit" });
      expect(events[1]).toEqual({
        type: "system_message",
        text: "__permission_mode::standard",
      });
    });
  });

  describe("Stop", () => {
    it("emits message_done with the last assistant message text", () => {
      const events = translateHookEvent("Stop", {
        last_assistant_message: "Done.",
        stop_hook_active: false,
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("message_done");
      const msg = events[0].message;
      expect(msg).toBeDefined();
      expect(msg?.role).toBe("assistant");
      expect(msg?.content).toBe("Done.");
      expect(msg?.toolUses).toEqual([]);
      expect(msg?.blocks).toEqual([]);
      expect(typeof msg?.id).toBe("string");
      expect(msg?.id.length).toBeGreaterThan(0);
      expect(typeof msg?.timestamp).toBe("number");
    });

    it("emits an empty-content message_done when no last_assistant_message is present", () => {
      const events = translateHookEvent("Stop", {});
      expect(events[0].message?.content).toBe("");
    });
  });

  describe("PermissionRequest", () => {
    it("emits a permission_request with a synthesised requestId and both serialized + raw input", () => {
      const events = translateHookEvent("PermissionRequest", {
        tool_name: "Write",
        tool_input: { file_path: "/tmp/x", content: "y" },
      });

      expect(events).toHaveLength(1);
      const ev = events[0];
      expect(ev.type).toBe("permission_request");
      expect(ev.toolName).toBe("Write");
      expect(ev.toolInput).toBe(JSON.stringify({ file_path: "/tmp/x", content: "y" }));
      expect(ev.rawToolInput).toEqual({ file_path: "/tmp/x", content: "y" });
      expect(typeof ev.requestId).toBe("string");
      expect(ev.requestId?.length).toBeGreaterThan(0);
    });

    it("each call generates a unique requestId", () => {
      const a = translateHookEvent("PermissionRequest", { tool_name: "Write", tool_input: {} });
      const b = translateHookEvent("PermissionRequest", { tool_name: "Write", tool_input: {} });
      expect(a[0].requestId).not.toBe(b[0].requestId);
    });

    it("falls back to 'unknown' toolName when missing", () => {
      const events = translateHookEvent("PermissionRequest", {});
      expect(events[0].toolName).toBe("unknown");
      expect(events[0].toolInput).toBe("");
      expect(events[0].rawToolInput).toBeUndefined();
    });
  });

  describe("Notification", () => {
    it("wraps the message string in a __notification:: system_message", () => {
      const events = translateHookEvent("Notification", { message: "Claude needs your attention" });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "system_message",
        text: "__notification::Claude needs your attention",
      });
    });

    it("returns no events when the message is empty or missing", () => {
      expect(translateHookEvent("Notification", {})).toEqual([]);
      expect(translateHookEvent("Notification", { message: "" })).toEqual([]);
    });
  });

  describe("UserPromptSubmit", () => {
    it("returns no events (status is handled by session manager)", () => {
      const events = translateHookEvent("UserPromptSubmit", { prompt: "hello", session_id: "s" });
      expect(events).toEqual([]);
    });
  });

  describe("PreCompact", () => {
    it("maps to __compact::hook_start regardless of trigger", () => {
      expect(translateHookEvent("PreCompact", { trigger: "auto" })).toEqual([{ type: "system_message", text: "__compact::hook_start" }]);
      expect(translateHookEvent("PreCompact", { trigger: "manual" })).toEqual([{ type: "system_message", text: "__compact::hook_start" }]);
    });
  });

  describe("PostCompact", () => {
    // The trigger decides whether the turn is over. An auto-compact fires
    // mid-turn on a tool-result boundary and the CLI resumes the same turn a
    // few seconds later, so it must not be reported as a turn ending; a manual
    // /compact is a standalone action with nothing to resume.
    it("carries trigger=auto through so the session manager can keep the turn running", () => {
      const events = translateHookEvent("PostCompact", { trigger: "auto", compact_summary: "..." });
      expect(events).toEqual([{ type: "system_message", text: "__compact::hook_done::auto" }]);
    });

    it("carries trigger=manual through as a real turn ending", () => {
      const events = translateHookEvent("PostCompact", { trigger: "manual", compact_summary: "..." });
      expect(events).toEqual([{ type: "system_message", text: "__compact::hook_done::manual" }]);
    });

    it("treats a missing or unrecognised trigger as manual, preserving pre-trigger CLI behaviour", () => {
      expect(translateHookEvent("PostCompact", {})).toEqual([{ type: "system_message", text: "__compact::hook_done::manual" }]);
      expect(translateHookEvent("PostCompact", { trigger: "" })).toEqual([
        { type: "system_message", text: "__compact::hook_done::manual" },
      ]);
      expect(translateHookEvent("PostCompact", { trigger: 42 })).toEqual([
        { type: "system_message", text: "__compact::hook_done::manual" },
      ]);
    });
  });
});

// Payloads below are copied from a real capture: every hook registered against
// a live CLI run that launched an async Explore agent. The order that run
// produced was PreToolUse(Agent), PostToolUse(Agent), SubagentStart, Stop
// (carrying background_tasks with the agent still running), the agent's own
// tools, then SubagentStop.
describe("subagent and background task hooks", () => {
  const AGENT_ID = "a924e4cda5649f1a6";

  it("keys a started subagent by agent id, not the parent session id", () => {
    const events = translateHookEvent("SubagentStart", {
      session_id: "463365f9-b0f8-413b-b2ab-3b73fbc14724",
      agent_id: AGENT_ID,
      agent_type: "Explore",
      hook_event_name: "SubagentStart",
    });

    expect(events).toEqual([
      {
        type: "task_update",
        taskInfo: { taskId: AGENT_ID, toolUseId: AGENT_ID, status: "running", title: "Explore", description: "Explore" },
      },
    ]);
  });

  it("gives concurrent agents distinct task ids", () => {
    const first = translateHookEvent("SubagentStart", { session_id: "sess", agent_id: "aaa", agent_type: "Explore" });
    const second = translateHookEvent("SubagentStart", { session_id: "sess", agent_id: "bbb", agent_type: "Explore" });

    expect(first[0].taskInfo?.taskId).toBe("aaa");
    expect(second[0].taskInfo?.taskId).toBe("bbb");
  });

  it("syncs the CLI's task list off Stop, which fires while the agent is still working", () => {
    const events = translateHookEvent("Stop", {
      session_id: "sess",
      last_assistant_message: "launched it",
      background_tasks: [{ id: AGENT_ID, type: "subagent", status: "running", description: "read note", agent_type: "Explore" }],
    });

    expect(events[0].type).toBe("message_done");
    expect(events[1]).toEqual({
      type: "task_sync",
      tasks: [{ taskId: AGENT_ID, toolUseId: AGENT_ID, status: "running", title: "Explore", description: "read note" }],
    });
  });

  it("syncs an empty list so a finished agent is dropped", () => {
    const events = translateHookEvent("Stop", { session_id: "sess", last_assistant_message: "done", background_tasks: [] });
    expect(events[1]).toEqual({ type: "task_sync", tasks: [] });
  });

  it("emits no sync when the payload carries no task list", () => {
    const events = translateHookEvent("Stop", { session_id: "sess", last_assistant_message: "done" });
    expect(events.some((e) => e.type === "task_sync")).toBe(false);
  });

  it("completes a stopped subagent by agent id and carries its final message", () => {
    const events = translateHookEvent("SubagentStop", {
      session_id: "463365f9-b0f8-413b-b2ab-3b73fbc14724",
      agent_id: AGENT_ID,
      agent_type: "Explore",
      last_assistant_message: "The full contents of note.txt are: hello world",
      background_tasks: [],
    });

    expect(events[0]).toEqual({
      type: "task_update",
      taskInfo: {
        taskId: AGENT_ID,
        toolUseId: AGENT_ID,
        status: "completed",
        title: "Explore",
        description: "Explore",
        summary: "The full contents of note.txt are: hello world",
      },
    });
    expect(events[1]).toEqual({ type: "task_sync", tasks: [] });
  });

  it("skips task entries with no id", () => {
    const events = translateHookEvent("Stop", {
      session_id: "sess",
      last_assistant_message: "x",
      background_tasks: [
        { status: "running", description: "no id" },
        { id: "ok", status: "running", description: "kept" },
      ],
    });
    expect(events[1].tasks).toEqual([{ taskId: "ok", toolUseId: "ok", status: "running", title: "Agent", description: "kept" }]);
  });
});

describe("newPermissionRequestId", () => {
  it("returns a uuid-like string", () => {
    const id = newPermissionRequestId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("returns a different id each call", () => {
    expect(newPermissionRequestId()).not.toBe(newPermissionRequestId());
  });
});
