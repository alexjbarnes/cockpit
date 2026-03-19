"use client";

import { useState, useEffect } from "react";
import { stripLineNumbers, highlightCode } from "@/lib/code-highlight";

export { languageFromPath } from "@/lib/code-highlight";

const htmlCache = new Map<string, string>();

function cacheKey(code: string, lang: string, theme: string): string {
  return `${theme}:${lang}:${code}`;
}

export function prehighlight(code: string, language: string, dark: boolean): void {
  const { code: stripped } = stripLineNumbers(code);
  const theme = dark ? "github-dark" : "github-light";
  const key = cacheKey(stripped, language, theme);
  if (htmlCache.has(key)) return;
  highlightCode(stripped, language, theme).then((result) => {
    if (result) htmlCache.set(key, result);
  });
}

interface CodeBlockProps {
  code: string;
  language?: string;
  dark?: boolean;
}

export function CodeBlock({ code, language, dark }: CodeBlockProps) {
  const { code: strippedCode, startLine } = stripLineNumbers(code);
  const theme = dark ? "github-dark" : "github-light";
  const key = language ? cacheKey(strippedCode, language, theme) : "";
  const [html, setHtml] = useState<string | null>(language ? htmlCache.get(key) ?? null : null);

  useEffect(() => {
    if (!language) {
      setHtml(null);
      return;
    }

    const cached = htmlCache.get(key);
    if (cached) {
      setHtml(cached);
      return;
    }

    let cancelled = false;

    highlightCode(strippedCode, language, theme).then((result) => {
      if (result) {
        htmlCache.set(key, result);
      }
      if (!cancelled) setHtml(result);
    });

    return () => {
      cancelled = true;
    };
  }, [strippedCode, language, theme, key]);

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
