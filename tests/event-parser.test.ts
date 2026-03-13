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
  it("ignores system init events", () => {
    const parser = new EventParser();
    const events = parser.parseLine(SYSTEM_INIT);
    expect(events).toEqual([]);
  });

  it("ignores rate limit events", () => {
    const parser = new EventParser();
    const events = parser.parseLine(RATE_LIMIT);
    expect(events).toEqual([]);
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

    expect(allEvents).toHaveLength(4);
    expect(allEvents[0].type).toBe("tool_use_start");
    expect(allEvents[1].type).toBe("tool_result");
    expect(allEvents[2].type).toBe("text_delta");
    expect(allEvents[3].type).toBe("message_done");
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
});
