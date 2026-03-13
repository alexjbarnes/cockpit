"use client";

import { useState } from "react";
import type { ChatMessage } from "@/types";
import { ToolCard } from "./tool-card";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "@/lib/utils";
import { Loader2, Check, ChevronDown, ChevronRight, Brain } from "lucide-react";

export function MessageBubble({ message, collapsedByDefault = false }: { message: ChatMessage; collapsedByDefault?: boolean }) {
  const [collapsed, setCollapsed] = useState(collapsedByDefault);
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const hasBlocks = message.blocks && message.blocks.length > 0;

  if (isSystem) {
    const isCompacting = message.content === "__compacting__";
    const isCompacted = message.content === "__compacted__";

    if (isCompacting || isCompacted) {
      return (
        <div className="flex w-full justify-center">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-1">
            {isCompacting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            {isCompacting ? "Compacting..." : "Compacted"}
          </div>
        </div>
      );
    }

    return (
      <div className="flex w-full justify-center">
        <div className="text-xs text-muted-foreground whitespace-pre-wrap py-1">
          {message.content}
        </div>
      </div>
    );
  }

  if (collapsed) {
    const preview = message.content.slice(0, 80).replace(/\n/g, " ");
    return (
      <div className="flex w-full justify-start">
        <button
          onClick={() => setCollapsed(false)}
          className="max-w-[85%] rounded-lg px-4 py-2 bg-muted text-foreground text-left"
        >
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ChevronRight className="h-3 w-3" />
            <span className="font-medium">Compaction summary</span>
          </div>
        </button>
      </div>
    );
  }

  return (
    <div className={cn("flex w-full", isUser && !collapsedByDefault ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-4 py-2",
          isUser && !collapsedByDefault
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        )}
      >
        {collapsedByDefault && (
          <button
            onClick={() => setCollapsed(true)}
            className="flex items-center gap-1 text-xs text-muted-foreground mb-2 hover:text-foreground"
          >
            <ChevronDown className="h-3 w-3" />
            <span className="font-medium">Compaction summary</span>
          </button>
        )}
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm">{message.content}</p>
        ) : hasBlocks ? (
          <div className="space-y-2">
            {message.blocks.map((block, i) =>
              block.type === "tool_use" ? (
                <ToolCard key={`tool-${i}`} tool={block.toolUse} />
              ) : block.type === "thinking" ? (
                <ThinkingBlock key={`thinking-${i}`} text={block.text} />
              ) : (
                <div
                  key={`text-${i}`}
                  className="prose prose-sm max-w-none dark:prose-invert [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-black/10 [&_pre]:p-3 [&_code]:text-xs"
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {block.text}
                  </ReactMarkdown>
                </div>
              )
            )}
          </div>
        ) : (
          <>
            {message.toolUses.length > 0 && (
              <div className="mb-2 space-y-1">
                {message.toolUses.map((tool) => (
                  <ToolCard key={tool.id} tool={tool} />
                ))}
              </div>
            )}
            <div className="prose prose-sm max-w-none dark:prose-invert [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-black/10 [&_pre]:p-3 [&_code]:text-xs">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {message.content}
              </ReactMarkdown>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded border border-purple-500/20 bg-purple-500/5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-purple-400 hover:text-purple-300"
      >
        <Brain className="h-3 w-3" />
        <span className="font-medium">Thinking</span>
        <span className="text-muted-foreground ml-1">
          {text.length.toLocaleString()} chars
        </span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 ml-auto" />
        ) : (
          <ChevronRight className="h-3 w-3 ml-auto" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-purple-500/20 px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap max-h-60 overflow-y-auto">
          {text}
        </div>
      )}
    </div>
  );
}
