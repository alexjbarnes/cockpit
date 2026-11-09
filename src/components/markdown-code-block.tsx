"use client";

import { Check, Copy } from "lucide-react";
import { Children, type HTMLAttributes, isValidElement, type ReactNode, useCallback, useState } from "react";
import { CodeBlock } from "@/components/code-block";

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

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function codeAndLanguage(children: ReactNode): { code: string; language?: string } {
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return { code: textOf(children) };
  const className = child.props.className ?? "";
  const language = /language-([\w-]+)/.exec(className)?.[1];
  return { code: textOf(child.props.children), language };
}

/** A fenced block in rendered Markdown. The code is highlighted by the same
 *  Pierre highlighter as a file, so the fence, the file viewer and the diff
 *  renderer share one palette and one set of line numbers. */
export function MarkdownCodeBlock({ children }: HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false);
  const { code, language } = codeAndLanguage(children);

  const handleCopy = useCallback(() => {
    const onSuccess = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(code)
        .then(onSuccess)
        .catch(() => {
          fallbackCopy(code) && onSuccess();
        });
    } else {
      fallbackCopy(code) && onSuccess();
    }
  }, [code]);

  return (
    <div className="not-prose group/code relative">
      <CodeBlock code={code} language={language} fullHeight wrap />
      <button
        onClick={handleCopy}
        className="absolute top-3 right-3 rounded border border-border bg-background/80 p-1.5 text-muted-foreground opacity-60 transition-opacity hover:text-foreground sm:opacity-0 sm:group-hover/code:opacity-100"
        title="Copy code"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
