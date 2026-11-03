"use client";

import { Check, Copy } from "lucide-react";
import { type HTMLAttributes, useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";

function fallbackCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
}

export function MarkdownCodeBlock(props: HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? "";
    const onSuccess = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(onSuccess)
        .catch(() => {
          fallbackCopy(text) && onSuccess();
        });
    } else {
      fallbackCopy(text) && onSuccess();
    }
  }, []);

  return (
    <div className="group/code relative">
      {/* Agent-written prose often arrives in a fence as one long line. Wrap
        it (and break unbroken tokens) instead of hiding it behind a sideways
        scrollbar; the copied text keeps its original line breaks. */}
      <pre ref={preRef} {...props} className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", props.className)} />
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded bg-background/80 border border-border text-muted-foreground hover:text-foreground opacity-60 sm:opacity-0 sm:group-hover/code:opacity-100 transition-opacity"
        title="Copy code"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
