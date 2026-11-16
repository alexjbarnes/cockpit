"use client";

import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownCodeBlock } from "@/components/markdown-code-block";
import { MarkdownImage } from "@/components/markdown-image";
import { isAppPath } from "@/lib/app-links";
import { cn } from "@/lib/utils";

/**
 * A link in rendered Markdown. One to a page of Cockpit's own is followed in
 * the app: opened in a new tab it would leave an installed app for the
 * browser. Every other link opens in a new tab, so following it never loses
 * the page it was on.
 */
function MarkdownLink({ href, node: _node, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  if (href && isAppPath(href)) return <Link {...props} href={href} />;
  return <a {...props} href={href} target="_blank" rel="noopener noreferrer" />;
}

const fullComponents = { pre: MarkdownCodeBlock, a: MarkdownLink, img: MarkdownImage };
const liteComponents = { a: MarkdownLink, img: MarkdownImage };
const FULL_PROSE = "message-prose prose prose-sm max-w-none dark:prose-invert";
// A long path or token with no break in it still wraps rather than widening
// whatever holds it.
const LITE_PROSE = "prose prose-sm max-w-none dark:prose-invert [overflow-wrap:anywhere]";

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
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={fullComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
