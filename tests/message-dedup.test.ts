import { describe, expect, it } from "vitest";
import { applyTranscript, buildQueuedUserMessage, buildUserMessage } from "@/hooks/message-ordering";
import { extractTextFiles } from "@/lib/paste-detect";
import type { ChatMessage } from "@/types";

const userMsg = (id: string, content: string): ChatMessage => ({
  id,
  role: "user",
  content,
  toolUses: [],
  blocks: [],
  timestamp: 1,
});

// Replicates use-session.ts sendMessage apiText building (the EXACT text sent to the CLI).
function buildApiText(text: string, textFiles: { name: string; content: string }[]): string {
  if (!textFiles.length) return text;
  const fileParts = textFiles.map((f) => `<file path="${f.name}">\n${f.content}\n</file>`);
  return fileParts.join("\n\n") + (text ? "\n\n" + text : "");
}

// Replicates the transcript parser's user-content derivation for a non-command turn
// (transcript.ts: extractTextFiles(stripCommandXml(content)).cleaned; stripCommandXml
// is a no-op for content that doesn't start with <command-*>).
function transcriptContentFor(apiText: string): string {
  return extractTextFiles(apiText).cleaned;
}

describe("REPRO: message with a paste attachment duplicating", () => {
  const prose =
    "I am trying to use an agent to do something using the @ command. When i send the message it perists but it just seems to get stuck in a processing state nothing seems to happen. When i refresh the message disapears all together but it is still stuck processing. Can you see anything in logs";
  const paste = Array.from({ length: 313 }, (_, i) => `[pty-runtime] line ${i} some log content here`).join("\n");
  const textFiles = [{ name: "paste.md", content: paste }];

  it("idle send: optimistic bubble dedups against the transcript copy", () => {
    const apiText = buildApiText(prose, textFiles);
    const transcript = userMsg("srv-1", transcriptContentFor(apiText));
    const optimistic = buildUserMessage(prose, "user-1", 1, { textFiles });
    const result = applyTranscript([optimistic], [transcript]);
    expect(result).toHaveLength(1);
  });

  it("queued send: queued bubble dedups against the transcript copy", () => {
    const apiText = buildApiText(prose, textFiles);
    const transcript = userMsg("srv-1", transcriptContentFor(apiText));
    const { message } = buildQueuedUserMessage(apiText, [{ text: prose, apiText, textFiles }], "user-queued-1", 1);
    const result = applyTranscript([message], [transcript]);
    expect(result).toHaveLength(1);
  });

  it("transcript that logs the same message twice (post-compaction re-log) renders ONE bubble", () => {
    // After a /compact the CLI re-logs earlier turns under the same message id.
    // applyTranscript trusts the transcript as source of truth, so two entries
    // with the same id render as two identical bubbles that survive a reload.
    const a = userMsg("dup-id", prose);
    const b = userMsg("dup-id", prose);
    const result = applyTranscript([], [a, b]);
    expect(result).toHaveLength(1);
  });
});

describe("REPRO: PTY 'clear line' NAK prefix duplicating a plain-text bubble", () => {
  // Real production data (verba session efe3bccf, 2026-06-27): 8 of 768 user turns
  // (~1%) were logged with a leading \x15 (Ctrl-U/NAK). pty-session.ts sendText writes
  // \x15 to clear the REPL line, then the text; sent in one read the CLI's paste
  // detection sometimes inserts the \x15 literally, so the TRANSCRIPT copy carries it
  // while the optimistic bubble (built from typed text) does not. Before the userKey
  // control-char strip, the keys differed and the message rendered as two identical
  // bubbles — exactly the screenshot the user reported on latest `next`.
  const prose = "Ok a couple spelled out, grapheme, vocab, re-download. I guess we can keep adding these as we go.";

  it("idle send: clean optimistic bubble dedups against a \\x15-prefixed transcript copy", () => {
    const transcript = userMsg("srv-1", `\x15${prose}`);
    const optimistic = buildUserMessage(prose, "user-1", 1);
    const result = applyTranscript([optimistic], [transcript]);
    expect(result).toHaveLength(1);
  });

  it("a leading NAK on its own (no optimistic) still renders one bubble on reload", () => {
    const result = applyTranscript([], [userMsg("srv-1", `\x15${prose}`)]);
    expect(result).toHaveLength(1);
  });

  it("other C0 controls in the transcript copy also reconcile (defensive)", () => {
    const transcript = userMsg("srv-1", `\x01\x15${prose}`);
    const optimistic = buildUserMessage(prose, "user-1", 1);
    expect(applyTranscript([optimistic], [transcript])).toHaveLength(1);
  });
});
