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
