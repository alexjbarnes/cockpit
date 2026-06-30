import { extractTextFiles } from "@/lib/paste-detect";
import type { ChatMessage, DocumentAttachment, ImageAttachment, TextFileAttachment } from "@/types";

const stripAttachments = (s: string) => s.replace(/^\[Attached [^\]]+\]\n*/gm, "").trim();

// Dedup key for matching an optimistic user bubble to its transcript copy. On top
// of stripping attachment markers it collapses every run of whitespace OR C0 control
// characters to a single space, so differences that are ONLY whitespace/controls
// still reconcile to one bubble: the transcript parser collapses blank-line gaps and
// rebuilds a slash command as "name arg" (single space), while the optimistic bubble
// keeps whatever the user typed (extra spaces, blank lines). The control-char half
// matters in PTY mode: the "clear line" write (pty-session.ts sendText) occasionally
// lands a literal \x15 (Ctrl-U/NAK) ahead of the text, which the CLI logs into the
// transcript; the optimistic bubble has no such byte, so without stripping it the
// keys differ and the bubble duplicates (~1% of PTY sends). Matching the raw string
// duplicated all of these.
// biome-ignore lint/suspicious/noControlCharactersInRegex: collapse C0 controls so a stray NAK can't defeat dedup
const CONTROL_OR_WHITESPACE = /[\x00-\x1f\s]+/g;
const userKey = (s: string) => stripAttachments(s).replace(CONTROL_OR_WHITESPACE, " ").trim();

export type QueuedText = {
  text: string;
  apiText: string;
  images?: ImageAttachment[];
  documents?: DocumentAttachment[];
  textFiles?: TextFileAttachment[];
};

/** Build the optimistic user bubble for a flushed queued message.
 *  `sentText` is the EXPANDED apiText the server echoes back. Content is set
 *  to the cleaned (collapsed) form so it equals what the transcript parser
 *  produces -> applyTranscript dedups it. Paste/image/doc metadata is recovered
 *  from the queued entry matched EXACTLY on apiText (whitespace-proof), with a
 *  parse-from-sentText fallback for the chip if the local queue ref was cleared. */
export function buildQueuedUserMessage(
  sentText: string,
  queued: QueuedText[],
  id: string,
  timestamp: number,
): { message: ChatMessage; matchedIndex: number } {
  const { cleaned, textFiles: parsed } = extractTextFiles(sentText);
  const matchedIndex = queued.findIndex((m) => m.apiText === sentText);
  const matched = matchedIndex !== -1 ? queued[matchedIndex] : null;
  return {
    matchedIndex,
    message: {
      id,
      role: "user",
      content: cleaned,
      toolUses: [],
      blocks: [],
      timestamp,
      images: matched?.images,
      documents: matched?.documents,
      textFiles: matched?.textFiles ?? (parsed.length > 0 ? parsed : undefined),
    },
  };
}

/** Build the optimistic user bubble for a direct (non-queued) send. Content is the
 *  CLEANED form (extractTextFiles collapses runs of 3+ newlines to 2, strips inline
 *  file blocks, and trims) so it equals what the transcript parser produces for the
 *  same turn -> applyTranscript dedups it instead of leaving a duplicate bubble.
 *  Passed attachments win; file blocks typed inline are recovered as a fallback. */
export function buildUserMessage(
  text: string,
  id: string,
  timestamp: number,
  attachments?: { images?: ImageAttachment[]; documents?: DocumentAttachment[]; textFiles?: TextFileAttachment[] },
): ChatMessage {
  const { cleaned, textFiles: parsed } = extractTextFiles(text);
  return {
    id,
    role: "user",
    content: cleaned,
    toolUses: [],
    blocks: [],
    timestamp,
    images: attachments?.images?.length ? attachments.images : undefined,
    documents: attachments?.documents?.length ? attachments.documents : undefined,
    textFiles: attachments?.textFiles?.length ? attachments.textFiles : parsed.length > 0 ? parsed : undefined,
  };
}

/**
 * Replace the "streaming" placeholder with a finalized assistant message,
 * keeping it at the same position in the array.
 */
export function applyMessageDone(prev: ChatMessage[], finalMessage: ChatMessage): ChatMessage[] {
  const streamIdx = prev.findIndex((m) => m.id === "streaming");
  const filtered = prev.filter((m) => m.id !== "streaming");
  if (filtered.some((m) => m.id === finalMessage.id)) return filtered;
  if (streamIdx >= 0) {
    const result = [...filtered];
    result.splice(streamIdx, 0, finalMessage);
    return result;
  }
  return [...filtered, finalMessage];
}

/**
 * Merge a server transcript into the current message list.
 * Uses transcript order as the source of truth for transcript messages,
 * then slots local-only messages (system, optimistic user) into their
 * approximate positions relative to surrounding transcript messages.
 */
export function applyTranscript(prev: ChatMessage[], transcriptMsgsRaw: ChatMessage[]): ChatMessage[] {
  // Defensive: collapse duplicate transcript entries by id (keep the first). A
  // compacted transcript can re-log a turn under the same id; the parser already
  // dedups, but rendering the transcript as source of truth must not double either.
  const seenTranscriptIds = new Set<string>();
  const transcriptMsgs = transcriptMsgsRaw.filter((m) => {
    if (seenTranscriptIds.has(m.id)) return false;
    seenTranscriptIds.add(m.id);
    return true;
  });
  const transcriptUserContent = new Set(transcriptMsgs.filter((m) => m.role === "user").map((m) => userKey(m.content)));
  const transcriptSystemContent = new Set(transcriptMsgs.filter((m) => m.role === "system").map((m) => m.content));

  // Build enriched versions of transcript messages, preserving any
  // client-side attachments (images, documents) from optimistic messages.
  const enrichedById = new Map<string, ChatMessage>();
  for (const m of transcriptMsgs) {
    if (m.role !== "user" || m.images?.length) {
      enrichedById.set(m.id, m);
      continue;
    }
    const stripped = userKey(m.content);
    const match = prev.find((p) => p.role === "user" && (p.images?.length || p.documents?.length) && userKey(p.content) === stripped);
    enrichedById.set(
      m.id,
      match ? { ...m, content: match.content, images: match.images, documents: match.documents, textFiles: match.textFiles } : m,
    );
  }

  // Build a set of all transcript IDs for quick lookup
  const transcriptIds = new Set(transcriptMsgs.map((m) => m.id));

  // Map optimistic user-* IDs to their transcript counterparts by content
  const optimisticToTranscript = new Map<string, string>();
  for (const p of prev) {
    if (!p.id.startsWith("user-")) continue;
    if (transcriptIds.has(p.id)) continue;
    const stripped = userKey(p.content);
    if (!transcriptUserContent.has(stripped)) continue;
    const match = transcriptMsgs.find((m) => m.role === "user" && userKey(m.content) === stripped && !optimisticToTranscript.has(m.id));
    if (match) optimisticToTranscript.set(p.id, match.id);
  }

  // Collect local-only messages (not in transcript) with their prev index
  const localMessages: Array<{ msg: ChatMessage; prevIdx: number }> = [];
  for (let i = 0; i < prev.length; i++) {
    const m = prev[i];
    if (m.id === "streaming") continue;
    if (transcriptIds.has(m.id)) continue;
    if (optimisticToTranscript.has(m.id)) continue;
    const isLocalSystem = m.role === "system" && !transcriptSystemContent.has(m.content);
    const isLocalUser = m.id.startsWith("user-") && !transcriptUserContent.has(userKey(m.content));
    if (isLocalSystem || isLocalUser) {
      localMessages.push({ msg: m, prevIdx: i });
    }
  }

  // Start with transcript messages in transcript order (the source of truth)
  const result: ChatMessage[] = transcriptMsgs.map((m) => enrichedById.get(m.id)!);

  // Slot local-only messages into approximate positions.
  // Find the nearest preceding transcript message in prev and insert after
  // its position in result.
  for (const { msg, prevIdx } of localMessages) {
    let insertAfter = -1;
    for (let j = prevIdx - 1; j >= 0; j--) {
      const neighbor = prev[j];
      const neighborTranscriptId = optimisticToTranscript.get(neighbor.id) || neighbor.id;
      const idx = result.findIndex((r) => r.id === neighborTranscriptId);
      if (idx >= 0) {
        insertAfter = idx;
        break;
      }
    }
    result.splice(insertAfter + 1, 0, msg);
  }

  return result;
}
