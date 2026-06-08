import { describe, expect, it } from "vitest";
import { buildQueuedUserMessage, type QueuedText } from "@/hooks/message-ordering";

const PASTE_SENT_TEXT = '<file path="paste.ts">\nconst x = 1\n</file>\n\nreview this';

describe("buildQueuedUserMessage", () => {
  it("returns matched entry when queue contains matching apiText", () => {
    const queued: QueuedText[] = [
      {
        text: "review this",
        apiText: PASTE_SENT_TEXT,
        textFiles: [{ name: "paste.ts", content: "const x = 1" }],
      },
    ];
    const result = buildQueuedUserMessage(PASTE_SENT_TEXT, queued, "user-queued-1", 1000);
    expect(result.matchedIndex).toBe(0);
    expect(result.message.content).toBe("review this");
    expect(result.message.textFiles).toEqual([{ name: "paste.ts", content: "const x = 1" }]);
    expect(result.message.images).toBeUndefined();
    expect(result.message.documents).toBeUndefined();
  });

  it("reconstructs textFiles from sentText when queue is empty (ref cleared)", () => {
    const result = buildQueuedUserMessage(PASTE_SENT_TEXT, [], "user-queued-2", 2000);
    expect(result.matchedIndex).toBe(-1);
    expect(result.message.content).toBe("review this");
    expect(result.message.textFiles).toEqual([{ name: "paste.ts", content: "const x = 1" }]);
  });

  it("recovers images from matched entry", () => {
    const queued: QueuedText[] = [
      {
        text: "review this",
        apiText: PASTE_SENT_TEXT,
        textFiles: [{ name: "paste.ts", content: "const x = 1" }],
        images: [{ mediaType: "image/png" as const, data: "abc" }],
        documents: [{ mediaType: "application/pdf" as const, data: "pdf content", name: "doc.pdf" }],
      },
    ];
    const result = buildQueuedUserMessage(PASTE_SENT_TEXT, queued, "user-queued-3", 3000);
    expect(result.matchedIndex).toBe(0);
    expect(result.message.images).toEqual([{ mediaType: "image/png", data: "abc" }]);
    expect(result.message.documents).toEqual([{ mediaType: "application/pdf", data: "pdf content", name: "doc.pdf" }]);
    expect(result.message.textFiles).toEqual([{ name: "paste.ts", content: "const x = 1" }]);
  });

  it("regression: message.content never contains <file path= substring", () => {
    const result = buildQueuedUserMessage(PASTE_SENT_TEXT, [], "user-queued-4", 4000);
    expect(result.message.content).not.toContain("<file path=");
  });

  it("handles sentText without any file blocks", () => {
    const queued: QueuedText[] = [{ text: "hello", apiText: "hello" }];
    const result = buildQueuedUserMessage("hello", queued, "user-queued-5", 5000);
    expect(result.matchedIndex).toBe(0);
    expect(result.message.content).toBe("hello");
    expect(result.message.textFiles).toBeUndefined();
  });

  it("fallback to undefined textFiles when sentText has no file blocks and queue is empty", () => {
    const result = buildQueuedUserMessage("plain text", [], "user-queued-6", 6000);
    expect(result.matchedIndex).toBe(-1);
    expect(result.message.content).toBe("plain text");
    expect(result.message.textFiles).toBeUndefined();
  });
});
