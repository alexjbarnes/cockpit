import { describe, it, expect } from "vitest";
import { EventParser } from "@/server/event-parser";

const SYSTEM_INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  cwd: "/home/user/project",
  session_id: "abc-123",
  tools: ["Bash", "Read"],
  model: "claude-opus-4-6",
});

const ASSISTANT_TEXT = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_01",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello world." }],
    stop_reason: null,
  },
  session_id: "abc-123",
});

const ASSISTANT_TOOL_USE = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_02",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_01",
        name: "Bash",
        input: { command: "ls", description: "List files" },
      },
    ],
    stop_reason: null,
  },
  session_id: "abc-123",
});

const ASSISTANT_MIXED = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_03",
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "Let me check:" },
      {
        type: "tool_use",
        id: "toolu_02",
        name: "Read",
        input: { file_path: "/tmp/test.txt" },
      },
    ],
    stop_reason: null,
  },
  session_id: "abc-123",
});

const USER_TOOL_RESULT = JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        tool_use_id: "toolu_01",
        type: "tool_result",
        content: "file1.txt\nfile2.txt",
        is_error: false,
      },
    ],
  },
  session_id: "abc-123",
});

const RESULT_SUCCESS = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Here are the files:\n- file1.txt\n- file2.txt",
  session_id: "abc-123",
  total_cost_usd: 0.01,
});

const RATE_LIMIT = JSON.stringify({
  type: "rate_limit_event",
  rate_limit_info: { status: "allowed" },
  session_id: "abc-123",
});

describe("EventParser", () => {
  it("forwards system init events as __system:: messages", () => {
    const parser = new EventParser();
    const events = parser.parseLine(SYSTEM_INIT);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "system_message", text: "__system::init" });
  });

  it("parses rate_limit_event into rate_limit", () => {
    const parser = new EventParser();
    const events = parser.parseLine(RATE_LIMIT);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("rate_limit");
    expect(events[0].rateLimitInfo).toEqual({ status: "allowed", retryAfterMs: undefined });
  });

  it("parses user tool_result events", () => {
    const parser = new EventParser();
    const events = parser.parseLine(USER_TOOL_RESULT);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_result");
    expect(events[0].toolId).toBe("toolu_01");
    expect(events[0].toolOutput).toBe("file1.txt\nfile2.txt");
  });

  it("ignores empty lines", () => {
    const parser = new EventParser();
    expect(parser.parseLine("")).toEqual([]);
    expect(parser.parseLine("   ")).toEqual([]);
  });

  it("ignores malformed JSON", () => {
    const parser = new EventParser();
    expect(parser.parseLine("{broken")).toEqual([]);
  });

  it("parses assistant text message", () => {
    const parser = new EventParser();
    const events = parser.parseLine(ASSISTANT_TEXT);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("text_delta");
    expect(events[0].text).toBe("Hello world.");
  });

  it("parses assistant tool_use message", () => {
    const parser = new EventParser();
    const events = parser.parseLine(ASSISTANT_TOOL_USE);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_use_start");
    expect(events[0].toolName).toBe("Bash");
    expect(events[0].toolId).toBe("toolu_01");
    expect(JSON.parse(events[0].toolInput!)).toEqual({
      command: "ls",
      description: "List files",
    });
  });

  it("parses assistant message with mixed text and tool_use", () => {
    const parser = new EventParser();
    const events = parser.parseLine(ASSISTANT_MIXED);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("text_delta");
    expect(events[0].text).toBe("Let me check:");
    expect(events[1].type).toBe("tool_use_start");
    expect(events[1].toolName).toBe("Read");
  });

  it("parses result event into message_done", () => {
    const parser = new EventParser();
    const events = parser.parseLine(RESULT_SUCCESS);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("message_done");
    expect(events[0].message).toBeDefined();
    expect(events[0].message!.role).toBe("assistant");
    expect(events[0].message!.content).toBe(
      "Here are the files:\n- file1.txt\n- file2.txt"
    );
  });

  it("handles a full conversation flow", () => {
    const parser = new EventParser();
    const allEvents = [
      SYSTEM_INIT,
      ASSISTANT_TOOL_USE,
      RATE_LIMIT,
      USER_TOOL_RESULT,
      ASSISTANT_TEXT,
      RESULT_SUCCESS,
    ].flatMap((line) => parser.parseLine(line));

    expect(allEvents).toHaveLength(6);
    expect(allEvents[0].type).toBe("system_message");
    expect(allEvents[1].type).toBe("tool_use_start");
    expect(allEvents[2].type).toBe("rate_limit");
    expect(allEvents[3].type).toBe("tool_result");
    expect(allEvents[4].type).toBe("text_delta");
    expect(allEvents[5].type).toBe("message_done");
  });

  it("handles result with empty content", () => {
    const parser = new EventParser();
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      session_id: "abc",
    });
    const events = parser.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0].message!.content).toBe("");
  });

  it("emits __compact::start for system status compacting", () => {
    const parser = new EventParser();
    const line = JSON.stringify({
      type: "system",
      subtype: "status",
      status: "compacting",
      session_id: "abc-123",
    });
    const events = parser.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "system_message", text: "__compact::start" });
  });

  it("forwards non-compacting status as __system::status", () => {
    const parser = new EventParser();
    const line = JSON.stringify({
      type: "system",
      subtype: "status",
      status: null,
      session_id: "abc-123",
    });
    const events = parser.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "system_message", text: "__system::status" });
  });

  it("handles assistant message with empty content array", () => {
    const parser = new EventParser();
    const line = JSON.stringify({
      type: "assistant",
      message: { id: "msg_x", content: [] },
      session_id: "abc",
    });
    const events = parser.parseLine(line);
    expect(events).toEqual([]);
  });

  it("parses tool_progress events", () => {
    const parser = new EventParser();
    const line = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "toolu_99",
      content: "partial output...",
    });
    const events = parser.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "tool_progress",
      toolId: "toolu_99",
      text: "partial output...",
    });
  });

  it("returns empty for tool_progress without toolId or content", () => {
    const parser = new EventParser();
    expect(parser.parseLine(JSON.stringify({ type: "tool_progress" }))).toEqual([]);
    expect(parser.parseLine(JSON.stringify({ type: "tool_progress", tool_use_id: "x" }))).toEqual([]);
    expect(parser.parseLine(JSON.stringify({ type: "tool_progress", content: "y" }))).toEqual([]);
  });

  it("parses rate_limit_event with retry_after_ms", () => {
    const parser = new EventParser();
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "rate_limited", retry_after_ms: 5000 },
    });
    const events = parser.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("rate_limit");
    expect(events[0].rateLimitInfo).toEqual({ status: "rate_limited", retryAfterMs: 5000 });
  });

  it("returns empty for rate_limit_event without info", () => {
    const parser = new EventParser();
    const events = parser.parseLine(JSON.stringify({ type: "rate_limit_event" }));
    expect(events).toEqual([]);
  });

  it("parses prompt_suggestion events", () => {
    const parser = new EventParser();
    const line = JSON.stringify({
      type: "prompt_suggestion",
      suggestions: ["fix the bug", "run tests"],
    });
    const events = parser.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("prompt_suggestion");
    expect(events[0].suggestions).toEqual(["fix the bug", "run tests"]);
  });

  it("parses prompt_suggestion with prompt_suggestions key", () => {
    const parser = new EventParser();
    const line = JSON.stringify({
      type: "prompt_suggestion",
      prompt_suggestions: ["option a"],
    });
    const events = parser.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0].suggestions).toEqual(["option a"]);
  });

  it("returns empty for prompt_suggestion with no suggestions", () => {
    const parser = new EventParser();
    expect(parser.parseLine(JSON.stringify({ type: "prompt_suggestion" }))).toEqual([]);
    expect(parser.parseLine(JSON.stringify({ type: "prompt_suggestion", suggestions: [] }))).toEqual([]);
  });

  it("parses auth_status as system message", () => {
    const parser = new EventParser();
    const line = JSON.stringify({ type: "auth_status", status: "authenticated" });
    const events = parser.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "system_message", text: "__auth::authenticated" });
  });

  it("parses auth_status with missing status", () => {
    const parser = new EventParser();
    const events = parser.parseLine(JSON.stringify({ type: "auth_status" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "system_message", text: "__auth::unknown" });
  });

  it("drops tool_use_summary events", () => {
    const parser = new EventParser();
    const events = parser.parseLine(JSON.stringify({ type: "tool_use_summary", summary: "did stuff" }));
    expect(events).toEqual([]);
  });

  it("drops stream_event events", () => {
    const parser = new EventParser();
    const events = parser.parseLine(JSON.stringify({ type: "stream_event", data: {} }));
    expect(events).toEqual([]);
  });

  it("refines hook_started subtype", () => {
    const parser = new EventParser();
    const line = JSON.stringify({ type: "system", subtype: "hook_started", hook_name: "pre-commit" });
    const events = parser.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "system_message", text: "__hook::started::pre-commit" });
  });

  it("refines hook_progress subtype", () => {
    const parser = new EventParser();
    const line = JSON.stringify({ type: "system", subtype: "hook_progress", content: "running checks" });
    const events = parser.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "system_message", text: "__hook::progress::running checks" });
  });

  it("refines hook_response subtype", () => {
    const parser = new EventParser();
    const line = JSON.stringify({ type: "system", subtype: "hook_response" });
    const events = parser.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "system_message", text: "__hook::done" });
  });

  it("parses task_started into structured task_update", () => {
    const parser = new EventParser();
    const line = JSON.stringify({
      type: "system",
      subtype: "task_started",
      task_id: "abc123",
      tool_use_id: "toolu_01",
      description: "Count project files",
    });
    const events = parser.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("task_update");
    expect(events[0].taskInfo).toEqual({
      taskId: "abc123",
      toolUseId: "toolu_01",
      status: "running",
      description: "Count project files",
    });
  });

  it("parses task_progress into structured task_update", () => {
    const parser = new EventParser();
    const line = JSON.stringify({
      type: "system",
      subtype: "task_progress",
      task_id: "abc123",
      tool_use_id: "toolu_01",
      description: "Running List top-level directories",
    });
    const events = parser.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("task_update");
    expect(events[0].taskInfo!.status).toBe("progress");
    expect(events[0].taskInfo!.description).toBe("Running List top-level directories");
  });

  it("parses task_notification into structured task_update with summary", () => {
    const parser = new EventParser();
    const line = JSON.stringify({
      type: "system",
      subtype: "task_notification",
      task_id: "abc123",
      tool_use_id: "toolu_01",
      status: "completed",
      summary: "Agent completed successfully",
    });
    const events = parser.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("task_update");
    expect(events[0].taskInfo).toEqual({
      taskId: "abc123",
      toolUseId: "toolu_01",
      status: "completed",
      description: "",
      summary: "Agent completed successfully",
    });
  });
});
