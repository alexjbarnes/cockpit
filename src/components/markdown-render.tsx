"use client";

import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { MarkdownCodeBlock } from "@/components/markdown-code-block";
import { cn } from "@/lib/utils";

function ExternalLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
}

const fullComponents = { pre: MarkdownCodeBlock, a: ExternalLink };
const liteComponents = { a: ExternalLink };
const FULL_PROSE = "message-prose prose prose-sm max-w-none dark:prose-invert";
const LITE_PROSE = "prose prose-sm max-w-none dark:prose-invert";

interface MarkdownRenderProps {
  content: string;
  variant?: "full" | "lite";
  className?: string;
}

export function MarkdownRender({ content, variant = "full", className }: MarkdownRenderProps) {
  if (variant === "lite") {
    return (
      <div className={cn(LITE_PROSE, className)}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={liteComponents}>
          {content}
        </ReactMarkdown>
      </div>
    );
  }
  return (
    <div className={cn(FULL_PROSE, className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={fullComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
