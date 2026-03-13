import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@/types";

/**
 * Replicate the transcript loading logic for compact_boundary entries
 * and the collapsedByDefault calculation from chat-view.
 */

interface TranscriptEntry {
  type: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  parent_tool_use_id?: string | null;
  message?: {
    id?: string | null;
    role?: string;
    content?: string | { type: string; text?: string }[];
  };
}

function loadMessagesFromEntries(entries: TranscriptEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let counter = 0;

  for (const entry of entries) {
    if (entry.parent_tool_use_id) continue;
    if (entry.isMeta) continue;

    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      messages.push({
        id: `compact-${counter++}`,
        role: "system",
        content: "__compacted__",
        toolUses: [],
        blocks: [],
        timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now(),
      });
      continue;
    }

    if (entry.type === "user" && entry.message) {
      const content = entry.message.content;
      if (typeof content === "string" && content.trim()) {
        messages.push({
          id: entry.message.id || `user-${counter++}`,
          role: "user",
          content,
          toolUses: [],
          blocks: [],
          timestamp: Date.now(),
        });
      }
      continue;
    }

    if (entry.type === "assistant" && entry.message) {
      const content = entry.message.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text)
          .join("");
        messages.push({
          id: entry.message.id || `asst-${counter++}`,
          role: "assistant",
          content: text,
          toolUses: [],
          blocks: [],
          timestamp: Date.now(),
        });
      }
    }
  }

  return messages;
}

function dedup(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  return messages.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

function getCollapsedByDefault(messages: ChatMessage[], index: number): boolean {
  return index > 0 && messages[index - 1].content === "__compacted__";
}

describe("compaction", () => {
  describe("transcript loading", () => {
    it("inserts __compacted__ system message for compact_boundary entries", () => {
      const entries: TranscriptEntry[] = [
        { type: "user", message: { id: "u1", role: "user", content: "Hello" } },
        { type: "assistant", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "Hi" }] } },
        { type: "system", subtype: "compact_boundary", uuid: "cb-1", timestamp: "2026-03-13T16:53:21.645Z" },
        { type: "user", message: { id: null, role: "user", content: "This session is being continued from a previous conversation" } },
        { type: "assistant", message: { id: "a2", role: "assistant", content: [{ type: "text", text: "Continuing..." }] } },
      ];

      const messages = loadMessagesFromEntries(entries);
      expect(messages).toHaveLength(5);
      expect(messages[2].role).toBe("system");
      expect(messages[2].content).toBe("__compacted__");
      expect(messages[2].id).toMatch(/^compact-/);
    });

    it("skips compact_boundary entries with isMeta flag", () => {
      const entries: TranscriptEntry[] = [
        { type: "system", subtype: "compact_boundary", uuid: "cb-1", isMeta: true },
        { type: "user", message: { id: "u1", role: "user", content: "Hello" } },
      ];

      const messages = loadMessagesFromEntries(entries);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
    });

    it("skips compact_boundary entries with parent_tool_use_id", () => {
      const entries: TranscriptEntry[] = [
        { type: "system", subtype: "compact_boundary", uuid: "cb-1", parent_tool_use_id: "tool-123" },
        { type: "user", message: { id: "u1", role: "user", content: "Hello" } },
      ];

      const messages = loadMessagesFromEntries(entries);
      expect(messages).toHaveLength(1);
    });

    it("generates fallback id when compact_boundary has no uuid", () => {
      const entries: TranscriptEntry[] = [
        { type: "system", subtype: "compact_boundary" },
      ];

      const messages = loadMessagesFromEntries(entries);
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toMatch(/^compact-/);
    });
  });

  describe("dedup with duplicate compact_boundary uuids", () => {
    it("keeps both compact markers even with same uuid (unique ids generated)", () => {
      const entries: TranscriptEntry[] = [
        { type: "user", message: { id: "u1", role: "user", content: "First message" } },
        { type: "system", subtype: "compact_boundary", uuid: "cb-same" },
        { type: "user", message: { id: null, role: "user", content: "Summary 1" } },
        { type: "assistant", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "Response 1" }] } },
        // CLI writes duplicate on resume
        { type: "system", subtype: "compact_boundary", uuid: "cb-same" },
        { type: "user", message: { id: null, role: "user", content: "Summary 2" } },
        { type: "assistant", message: { id: "a2", role: "assistant", content: [{ type: "text", text: "Response 2" }] } },
      ];

      const messages = loadMessagesFromEntries(entries);
      const deduped = dedup(messages);

      // Both compact markers survive because each gets a unique generated id
      const compactedCount = deduped.filter((m) => m.content === "__compacted__").length;
      expect(compactedCount).toBe(2);

      // Both summaries should be collapsed
      const summary1 = deduped.find((m) => m.content === "Summary 1");
      const summary2 = deduped.find((m) => m.content === "Summary 2");
      expect(summary1).toBeDefined();
      expect(summary2).toBeDefined();
      expect(getCollapsedByDefault(deduped, deduped.indexOf(summary1!))).toBe(true);
      expect(getCollapsedByDefault(deduped, deduped.indexOf(summary2!))).toBe(true);
    });
  });

  describe("collapsedByDefault", () => {
    it("collapses message immediately following __compacted__", () => {
      const entries: TranscriptEntry[] = [
        { type: "user", message: { id: "u1", role: "user", content: "Hello" } },
        { type: "system", subtype: "compact_boundary", uuid: "cb-1" },
        { type: "user", message: { id: null, role: "user", content: "This session is being continued..." } },
        { type: "assistant", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "Continuing" }] } },
      ];

      const messages = dedup(loadMessagesFromEntries(entries));
      const summaryIdx = messages.findIndex((m) => m.content.startsWith("This session"));
      expect(summaryIdx).toBeGreaterThan(0);
      expect(getCollapsedByDefault(messages, summaryIdx)).toBe(true);
    });

    it("does not collapse messages not following __compacted__", () => {
      const entries: TranscriptEntry[] = [
        { type: "user", message: { id: "u1", role: "user", content: "Hello" } },
        { type: "system", subtype: "compact_boundary", uuid: "cb-1" },
        { type: "user", message: { id: null, role: "user", content: "Summary" } },
        { type: "assistant", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "Response" }] } },
        { type: "user", message: { id: "u2", role: "user", content: "Next question" } },
      ];

      const messages = dedup(loadMessagesFromEntries(entries));
      const nextIdx = messages.findIndex((m) => m.content === "Next question");
      expect(getCollapsedByDefault(messages, nextIdx)).toBe(false);
    });

    it("does not collapse the __compacted__ system message itself", () => {
      const entries: TranscriptEntry[] = [
        { type: "user", message: { id: "u1", role: "user", content: "Hello" } },
        { type: "system", subtype: "compact_boundary", uuid: "cb-1" },
      ];

      const messages = dedup(loadMessagesFromEntries(entries));
      const compactedIdx = messages.findIndex((m) => m.content === "__compacted__");
      expect(getCollapsedByDefault(messages, compactedIdx)).toBe(false);
    });

    it("handles multiple compactions correctly", () => {
      const entries: TranscriptEntry[] = [
        { type: "user", message: { id: "u1", role: "user", content: "Start" } },
        { type: "system", subtype: "compact_boundary", uuid: "cb-1" },
        { type: "user", message: { id: null, role: "user", content: "Summary 1" } },
        { type: "assistant", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "Response 1" }] } },
        { type: "user", message: { id: "u2", role: "user", content: "More work" } },
        { type: "system", subtype: "compact_boundary", uuid: "cb-2" },
        { type: "user", message: { id: null, role: "user", content: "Summary 2" } },
        { type: "assistant", message: { id: "a2", role: "assistant", content: [{ type: "text", text: "Response 2" }] } },
      ];

      const messages = dedup(loadMessagesFromEntries(entries));

      const summary1Idx = messages.findIndex((m) => m.content === "Summary 1");
      const summary2Idx = messages.findIndex((m) => m.content === "Summary 2");

      expect(getCollapsedByDefault(messages, summary1Idx)).toBe(true);
      expect(getCollapsedByDefault(messages, summary2Idx)).toBe(true);
    });

    it("handles real-world scenario: duplicate compact_boundary uuids from CLI resume", () => {
      // This matches what we see in real JSONL files:
      // compact_boundary is written once, then re-written on resume with same UUID
      const entries: TranscriptEntry[] = [
        { type: "user", message: { id: "u1", role: "user", content: "Before compact" } },
        { type: "assistant", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "Reply" }] } },
        { type: "system", subtype: "compact_boundary", uuid: "9ccdc811-same-uuid" },
        { type: "user", message: { id: null, role: "user", content: "This session is being continued from a previous conversation that ran out of context." } },
        { type: "assistant", message: { id: "a2", role: "assistant", content: [{ type: "text", text: "Based on summary..." }] } },
        { type: "user", message: { id: "u2", role: "user", content: "Did you just compact?" } },
        { type: "assistant", message: { id: "a3", role: "assistant", content: [{ type: "text", text: "Yes" }] } },
        // CLI resume re-writes the same boundary
        { type: "system", subtype: "compact_boundary", uuid: "9ccdc811-same-uuid" },
        { type: "user", message: { id: null, role: "user", content: "This session is being continued from a previous conversation..." } },
        { type: "assistant", message: { id: "a4", role: "assistant", content: [{ type: "text", text: "Continuing..." }] } },
      ];

      const messages = dedup(loadMessagesFromEntries(entries));

      // First summary should be collapsed
      const firstSummary = messages.find((m) => m.content.includes("that ran out of context"));
      expect(firstSummary).toBeDefined();
      const firstIdx = messages.indexOf(firstSummary!);
      expect(getCollapsedByDefault(messages, firstIdx)).toBe(true);

      // Second summary should also be collapsed (unique IDs for compact markers)
      const secondSummary = messages.findLast((m) => m.content.includes("being continued from a previous"));
      expect(secondSummary).toBeDefined();
      if (secondSummary && secondSummary !== firstSummary) {
        const secondIdx = messages.indexOf(secondSummary);
        expect(getCollapsedByDefault(messages, secondIdx)).toBe(true);
      }
    });
  });
});
