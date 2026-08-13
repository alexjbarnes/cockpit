import { describe, expect, it } from "vitest";
import { applyMessageDone, applyTranscript, buildUserMessage, pushPendingQuestion } from "@/hooks/message-ordering";
import { extractTextFiles } from "@/lib/paste-detect";
import type { ChatMessage } from "@/types";

function msg(id: string, role: "user" | "assistant" | "system", content: string): ChatMessage {
  return { id, role, content, toolUses: [], blocks: [], timestamp: Date.now() };
}

function msgWithFiles(
  id: string,
  role: "user" | "assistant" | "system",
  content: string,
  textFiles?: ChatMessage["textFiles"],
  images?: ChatMessage["images"],
  documents?: ChatMessage["documents"],
): ChatMessage {
  return { id, role, content, toolUses: [], blocks: [], timestamp: Date.now(), textFiles, images, documents };
}

describe("buildUserMessage", () => {
  it("collapses 3+ newline runs so the optimistic content matches the transcript copy", () => {
    const typed = "First paragraph.\n\n\nSecond paragraph.";
    const built = buildUserMessage(typed, "user-1", 1);
    // Must equal what the transcript parser produces for the same turn.
    expect(built.content).toBe(extractTextFiles(typed).cleaned);
    expect(built.content).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("keeps passed attachments and recovers inline file blocks", () => {
    const built = buildUserMessage("hi\n\n\nthere", "user-2", 2, {
      textFiles: [{ name: "a.txt", content: "x" }],
    });
    expect(built.content).toBe("hi\n\nthere");
    expect(built.textFiles).toEqual([{ name: "a.txt", content: "x" }]);
    expect(built.role).toBe("user");
  });

  it("regression: a slash command with args dedups against the reconstructed transcript copy", () => {
    // The parser now reconstructs "/model claude-opus-4-8" (name + args); the
    // optimistic bubble must equal that so the two collapse to one.
    const optimistic = buildUserMessage("/model claude-opus-4-8", "user-1", 1);
    const transcript = msg("srv-1", "user", "/model claude-opus-4-8");
    const result = applyTranscript([optimistic], [transcript]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("srv-1");
  });

  it("regression: extra whitespace between a command and its args still dedups", () => {
    // The reported case: the optimistic bubble keeps the user's double space, the
    // parser rebuilds the command with a single space. Whitespace-only differences
    // must still reconcile to one bubble.
    const optimistic = buildUserMessage("/iph-ai-toolkit:review  https://example.com/pull/1", "user-1", 1);
    const transcript = msg("srv-1", "user", "/iph-ai-toolkit:review https://example.com/pull/1");
    const result = applyTranscript([optimistic], [transcript]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("srv-1");
  });

  it("regression: a sent message with blank-line gaps does not leave a duplicate bubble", () => {
    // The exact shape that used to duplicate: optimistic bubble built from the
    // typed text, transcript copy cleaned by the parser. They must reconcile to one.
    const typed = "Question:\n\n\nWhy does this happen?";
    const optimistic = buildUserMessage(typed, "user-1", 1);
    const transcript = msg("srv-1", "user", extractTextFiles(typed).cleaned);
    const result = applyTranscript([optimistic], [transcript]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("srv-1");
  });
});

describe("applyMessageDone", () => {
  it("replaces streaming with finalized message at the same position", () => {
    const prev = [msg("user-1", "user", "hello"), msg("streaming", "assistant", "response"), msg("user-queued-2", "user", "follow up")];
    const finalMessage = msg("server-assistant-1", "assistant", "response");

    const result = applyMessageDone(prev, finalMessage);

    expect(result.map((m) => m.id)).toEqual(["user-1", "server-assistant-1", "user-queued-2"]);
  });

  it("appends at end when no streaming message exists", () => {
    const prev = [msg("user-1", "user", "hello")];
    const finalMessage = msg("server-assistant-1", "assistant", "response");

    const result = applyMessageDone(prev, finalMessage);

    expect(result.map((m) => m.id)).toEqual(["user-1", "server-assistant-1"]);
  });

  it("deduplicates if finalized message already in prev", () => {
    const prev = [
      msg("user-1", "user", "hello"),
      msg("server-assistant-1", "assistant", "response"),
      msg("streaming", "assistant", "response"),
    ];
    const finalMessage = msg("server-assistant-1", "assistant", "response");

    const result = applyMessageDone(prev, finalMessage);

    expect(result.map((m) => m.id)).toEqual(["user-1", "server-assistant-1"]);
  });

  it("preserves order with multiple queued messages after streaming", () => {
    const prev = [
      msg("user-1", "user", "first"),
      msg("streaming", "assistant", "working..."),
      msg("user-queued-2", "user", "second"),
      msg("user-queued-3", "user", "third"),
    ];
    const finalMessage = msg("server-assistant-1", "assistant", "done");

    const result = applyMessageDone(prev, finalMessage);

    expect(result.map((m) => m.id)).toEqual(["user-1", "server-assistant-1", "user-queued-2", "user-queued-3"]);
  });
});

describe("applyTranscript", () => {
  it("replaces optimistic user message in-place with server version", () => {
    const prev = [msg("user-1", "user", "hello"), msg("server-assistant-1", "assistant", "response")];
    const transcript = [msg("server-user-1", "user", "hello"), msg("server-assistant-1", "assistant", "response")];

    const result = applyTranscript(prev, transcript);

    expect(result.map((m) => m.id)).toEqual(["server-user-1", "server-assistant-1"]);
  });

  it("maintains user-before-assistant order when message_done corrupted prev", () => {
    // This is the key bug: assistant:message_done appended at end,
    // so prev has [user-1, user-queued-2, assistant-1] instead of
    // [user-1, assistant-1, user-queued-2]
    const prev = [
      msg("user-1", "user", "hello"),
      msg("user-queued-2", "user", "follow up"),
      msg("server-assistant-1", "assistant", "response to hello"),
    ];
    const transcript = [
      msg("server-user-1", "user", "hello"),
      msg("server-assistant-1", "assistant", "response to hello"),
      msg("server-user-2", "user", "follow up"),
    ];

    const result = applyTranscript(prev, transcript);

    expect(result.map((m) => m.id)).toEqual(["server-user-1", "server-assistant-1", "server-user-2"]);
  });

  it("handles multi-turn conversation with correct ordering", () => {
    // After multiple turns with the message_done bug, prev is corrupted:
    // all user messages bunched together, all assistant messages bunched together
    const prev = [
      msg("user-1", "user", "first question"),
      msg("user-2", "user", "second question"),
      msg("user-3", "user", "third question"),
      msg("server-a1", "assistant", "first answer"),
      msg("server-a2", "assistant", "second answer"),
    ];
    const transcript = [
      msg("server-u1", "user", "first question"),
      msg("server-a1", "assistant", "first answer"),
      msg("server-u2", "user", "second question"),
      msg("server-a2", "assistant", "second answer"),
      msg("server-u3", "user", "third question"),
    ];

    const result = applyTranscript(prev, transcript);

    expect(result.map((m) => m.id)).toEqual(["server-u1", "server-a1", "server-u2", "server-a2", "server-u3"]);
  });

  it("preserves local system messages at their approximate positions", () => {
    const prev = [
      msg("server-u1", "user", "hello"),
      msg("server-a1", "assistant", "hi"),
      msg("compact-done-123", "system", "__compacted__"),
      msg("user-2", "user", "after compact"),
    ];
    const transcript = [msg("server-u1", "user", "hello"), msg("server-a1", "assistant", "hi"), msg("server-u2", "user", "after compact")];

    const result = applyTranscript(prev, transcript);

    const ids = result.map((m) => m.id);
    expect(ids).toContain("compact-done-123");
    // Compaction marker should stay between a1 and the next user message
    expect(ids.indexOf("compact-done-123")).toBeGreaterThan(ids.indexOf("server-a1"));
    expect(ids.indexOf("server-u2")).toBeGreaterThan(ids.indexOf("compact-done-123"));
  });

  it("does not duplicate messages present in both prev and transcript", () => {
    const prev = [msg("server-u1", "user", "hello"), msg("server-a1", "assistant", "hi")];
    const transcript = [msg("server-u1", "user", "hello"), msg("server-a1", "assistant", "hi")];

    const result = applyTranscript(prev, transcript);

    expect(result.map((m) => m.id)).toEqual(["server-u1", "server-a1"]);
  });

  it("deduplicates injected paste bubble against transcript message by content", () => {
    const prev = [
      msgWithFiles("user-queued-1", "user", "review this", [{ name: "paste.ts", content: "const x = 1" }]),
      msg("server-a1", "assistant", "response"),
    ];
    const transcript = [
      msgWithFiles("t-user-1", "user", "review this", [{ name: "paste.ts", content: "const x = 1" }]),
      msg("server-a1", "assistant", "response"),
    ];

    const result = applyTranscript(prev, transcript);

    const userMessages = result.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].id).toBe("t-user-1");
    expect(userMessages[0].textFiles).toEqual([{ name: "paste.ts", content: "const x = 1" }]);
  });

  it("preserves textFiles on transcript user message through enrichment when no images/documents", () => {
    const result = applyTranscript([], [msgWithFiles("t-user-1", "user", "review this", [{ name: "paste.ts", content: "const x = 1" }])]);

    expect(result).toHaveLength(1);
    expect(result[0].textFiles).toEqual([{ name: "paste.ts", content: "const x = 1" }]);
  });
});

describe("pushPendingQuestion", () => {
  it("appends a new request id", () => {
    const result = pushPendingQuestion([], { requestId: "r1", questions: "q" });
    expect(result).toHaveLength(1);
  });

  it("refuses to stack a second entry for a request id already held", () => {
    const first = pushPendingQuestion([], { requestId: "r1", questions: "q" });
    const second = pushPendingQuestion(first, { requestId: "r1", questions: "q" });
    expect(second).toHaveLength(1);
  });

  it("keeps an answered entry so the id stays taken", () => {
    const first = pushPendingQuestion([{ requestId: "r1", questions: "q", answered: true }], { requestId: "r1", questions: "q" });
    expect(first).toHaveLength(1);
    expect(first[0].answered).toBe(true);
  });
});
