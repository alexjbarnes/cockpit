import { extractTextFiles } from "@/lib/paste-detect";
import type { ChatMessage, DocumentAttachment, ImageAttachment, TextFileAttachment } from "@/types";

const stripAttachments = (s: string) => s.replace(/^\[Attached [^\]]+\]\n*/gm, "").trim();

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
export function applyTranscript(prev: ChatMessage[], transcriptMsgs: ChatMessage[]): ChatMessage[] {
  const transcriptUserContent = new Set(transcriptMsgs.filter((m) => m.role === "user").map((m) => stripAttachments(m.content)));
  const transcriptSystemContent = new Set(transcriptMsgs.filter((m) => m.role === "system").map((m) => m.content));

  // Build enriched versions of transcript messages, preserving any
  // client-side attachments (images, documents) from optimistic messages.
  const enrichedById = new Map<string, ChatMessage>();
  for (const m of transcriptMsgs) {
    if (m.role !== "user" || m.images?.length) {
      enrichedById.set(m.id, m);
      continue;
    }
    const stripped = stripAttachments(m.content);
    const match = prev.find(
      (p) => p.role === "user" && (p.images?.length || p.documents?.length) && stripAttachments(p.content) === stripped,
    );
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
    const stripped = stripAttachments(p.content);
    if (!transcriptUserContent.has(stripped)) continue;
    const match = transcriptMsgs.find(
      (m) => m.role === "user" && stripAttachments(m.content) === stripped && !optimisticToTranscript.has(m.id),
    );
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
    const isLocalUser = m.id.startsWith("user-") && !transcriptUserContent.has(stripAttachments(m.content));
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
