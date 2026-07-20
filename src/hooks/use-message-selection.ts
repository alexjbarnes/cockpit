"use client";

import { useCallback, useState } from "react";
import type { ChatMessage } from "@/types";

export function extractText(message: ChatMessage): string {
  if (message.role === "system") return "";

  if (message.role === "user") return message.content;

  // Assistant: use text blocks only, fall back to content
  const textBlocks = message.blocks.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text);

  return textBlocks.length > 0 ? textBlocks.join("\n") : message.content;
}

/** Write text to the clipboard, falling back to a hidden textarea + execCommand. */
export async function copyToClipboard(text: string): Promise<void> {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

export function useMessageSelection() {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectionMode = selectedIds.size > 0;

  const enterSelection = useCallback((messageId: string) => {
    setSelectedIds(new Set([messageId]));
  }, []);

  const toggleSelect = useCallback((messageId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const copySelected = useCallback(
    async (messages: ChatMessage[]) => {
      const selected = messages.filter((m) => selectedIds.has(m.id) && m.role !== "system");
      const text = selected.map(extractText).filter(Boolean).join("\n\n---\n\n");
      await copyToClipboard(text);
      setSelectedIds(new Set());
    },
    [selectedIds],
  );

  return {
    selectedIds,
    selectionMode,
    enterSelection,
    toggleSelect,
    clearSelection,
    copySelected,
  };
}
