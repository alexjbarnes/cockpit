"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** Copies an issue's key, with a tick for a moment. Stops the click and the
 *  key press from reaching a surrounding row, which opens the issue. */
export function CopyIssueKey({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      onKeyDown={(e) => e.stopPropagation()}
      data-testid={`copy-issue-${value}`}
      aria-label="Copy issue ID"
      title="Copy issue ID"
      className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
