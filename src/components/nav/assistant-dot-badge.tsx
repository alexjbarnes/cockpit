"use client";

import type { AssistantDot } from "@/lib/assistant-dot";
import { cn } from "@/lib/utils";

/** The assistant's dot, the same three states a session row shows. */
export const ASSISTANT_DOT_STYLE: Record<AssistantDot, { className: string; title: string }> = {
  pending: { className: "bg-blue-500", title: "Awaiting your input" },
  working: { className: "bg-yellow-500", title: "Working" },
  unread: { className: "bg-green-500", title: "New response" },
};

export function AssistantDotBadge({ dot, testId = "assistant-dot" }: { dot: AssistantDot | null; testId?: string }) {
  if (!dot) return null;
  const style = ASSISTANT_DOT_STYLE[dot];
  return (
    <span
      className={cn("absolute top-1 right-1 h-2 w-2 rounded-full", style.className)}
      data-testid={testId}
      data-state={dot}
      title={style.title}
    />
  );
}
