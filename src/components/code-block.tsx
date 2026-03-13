"use client";

import { useState, useEffect } from "react";
import { stripLineNumbers, highlightCode } from "@/lib/code-highlight";

export { languageFromPath } from "@/lib/code-highlight";

interface CodeBlockProps {
  code: string;
  language?: string;
  dark?: boolean;
}

export function CodeBlock({ code, language, dark }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const { code: strippedCode, startLine } = stripLineNumbers(code);
  const theme = dark ? "github-dark" : "github-light";

  useEffect(() => {
    if (!language) {
      setHtml(null);
      return;
    }

    let cancelled = false;

    highlightCode(strippedCode, language, theme).then((result) => {
      if (!cancelled) setHtml(result);
    });

    return () => {
      cancelled = true;
    };
  }, [strippedCode, language, theme]);

  const lineNumberStyles = `
    .code-block-lines code {
      counter-reset: line ${startLine - 1};
    }
    .code-block-lines code .line::before {
      counter-increment: line;
      content: counter(line);
      display: inline-block;
      width: 3ch;
      margin-right: 1.5ch;
      text-align: right;
      color: var(--line-number-color, rgba(115,138,148,0.4));
      user-select: none;
    }
  `;

  if (html) {
    return (
      <div
        className="code-block-lines overflow-x-auto rounded text-[11px] leading-relaxed max-h-64 overflow-y-auto [&_pre]:!bg-transparent [&_pre]:p-2 [&_pre]:m-0"
      >
        <style>{lineNumberStyles}</style>
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    );
  }

  return (
    <pre className="overflow-x-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed max-h-64 overflow-y-auto">
      {strippedCode}
    </pre>
  );
}
