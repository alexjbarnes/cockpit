"use client";

import { useState, useCallback, useRef, memo } from "react";
import type { ChatMessage } from "@/types";
import { ToolCard } from "./tool-card";
import { useSettings } from "@/hooks/use-settings";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "@/lib/utils";
import { Loader2, Check, ChevronDown, ChevronRight, Brain, FileText, File } from "lucide-react";

const CLI_XML_RE = /<(?:task-notification|local-command-caveat|local-command-stdout|command-name|system-reminder)[^>]*>[\s\S]*?<\/(?:task-notification|local-command-caveat|local-command-stdout|command-name|system-reminder)>[\s\S]*/g;

function stripCliXml(text: string): string {
  return text.replace(CLI_XML_RE, "").trim();
}

interface MessageBubbleProps {
  message: ChatMessage;
  collapsedByDefault?: boolean;
  selectionMode?: boolean;
  selected?: boolean;
  onEnterSelection?: (messageId: string) => void;
  onToggleSelect?: (messageId: string) => void;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  collapsedByDefault = false,
  selectionMode = false,
  selected = false,
  onEnterSelection,
  onToggleSelect,
}: MessageBubbleProps) {
  const [collapsed, setCollapsed] = useState(collapsedByDefault);
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isSelectable = !isSystem;
  const visibleBlocks = message.blocks?.filter((b) => !(b.type === "tool_use" && b.toolUse.name === "AskUserQuestion")) || [];
  const hasBlocks = visibleBlocks.length > 0;

  const lastInputWasTouch = useRef(false);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);

  // Desktop: right-click enters message selection
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (lastInputWasTouch.current) return; // let native long-press text selection work
    if (!isSelectable) return;
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    if (selectionMode) {
      onToggleSelect?.(message.id);
    } else {
      onEnterSelection?.(message.id);
    }
  }, [isSelectable, selectionMode, message.id, onEnterSelection, onToggleSelect]);

  const handleTouchStart = useCallback(() => {
    lastInputWasTouch.current = true;
  }, []);

  const handleMouseDown = useCallback(() => {
    lastInputWasTouch.current = false;
  }, []);

  // Double-tap/click enters message selection (touch + desktop)
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (selectionMode) {
      if (isSelectable) onToggleSelect?.(message.id);
      return;
    }
    if (!isSelectable) return;
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && now - prev.time < 300) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      if (dx * dx + dy * dy < 400) {
        lastTap.current = null;
        window.getSelection()?.removeAllRanges();
        onEnterSelection?.(message.id);
        return;
      }
    }
    lastTap.current = { time: now, x: e.clientX, y: e.clientY };
  }, [selectionMode, isSelectable, message.id, onToggleSelect, onEnterSelection]);

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

  // Skip empty assistant bubbles (e.g. message only had AskUserQuestion)
  if (!isUser && !isSystem && !hasBlocks && !message.content && message.toolUses.every((t) => t.name === "AskUserQuestion")) {
    return null;
  }

  if (collapsed) {
    const preview = message.content.slice(0, 80).replace(/\n/g, " ");
    return (
      <div className="flex w-full justify-start">
        <button
          onClick={() => setCollapsed(false)}
          className="max-w-[85%] rounded-lg px-4 py-2 bg-muted text-foreground text-left overflow-hidden"
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
    <div
      className={cn(
        "flex w-full",
        isUser && !collapsedByDefault ? "justify-end" : "justify-start",
        selectionMode && "cursor-pointer select-none"
      )}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-4 py-2 overflow-hidden transition-colors",
          isUser && !collapsedByDefault
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground",
          selected && "ring-2 ring-blue-500"
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
          <>
            {message.images && message.images.length > 0 && (
              <div className="flex gap-2 flex-wrap mb-2">
                {message.images.map((img, i) => (
                  <img
                    key={i}
                    src={`data:${img.mediaType};base64,${img.data}`}
                    className="max-h-60 rounded border border-primary-foreground/20 object-contain"
                    alt=""
                  />
                ))}
              </div>
            )}
            {message.documents && message.documents.length > 0 && (
              <div className="flex gap-2 flex-wrap mb-2">
                {message.documents.map((doc, i) => (
                  <div key={i} className="flex items-center gap-1.5 rounded border border-primary-foreground/20 px-2 py-1 text-xs">
                    <FileText className="h-3.5 w-3.5" />
                    <span>{doc.name}</span>
                  </div>
                ))}
              </div>
            )}
            {message.textFiles && message.textFiles.length > 0 && (
              <div className="space-y-1.5 mb-2">
                {message.textFiles.map((f, i) => (
                  <TextFileBlock key={i} name={f.name} content={f.content} />
                ))}
              </div>
            )}
            {message.content && <p className="whitespace-pre-wrap text-sm">{message.content}</p>}
          </>
        ) : hasBlocks ? (
          <div className="space-y-2">
            {visibleBlocks.map((block, i) =>
              block.type === "tool_use" ? (
                <ToolCard key={`tool-${i}`} tool={block.toolUse} />
              ) : block.type === "thinking" ? (
                <ThinkingBlock key={`thinking-${i}`} text={block.text} />
              ) : (
                <div
                  key={`text-${i}`}
                  className="message-prose prose prose-sm max-w-none dark:prose-invert"
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {stripCliXml(block.text)}
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
            <div className="message-prose prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {stripCliXml(message.content)}
              </ReactMarkdown>
            </div>
          </>
        )}
      </div>
    </div>
  );
});

function TextFileBlock({ name, content }: { name: string; content: string }) {
  const [expanded, setExpanded] = useState(false);
  const lineCount = content.split("\n").length;

  return (
    <div className="rounded border border-blue-500/20 bg-blue-500/5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-blue-400 hover:text-blue-300"
      >
        <File className="h-3 w-3" />
        <span className="font-medium">{name}</span>
        <span className="text-muted-foreground ml-1">
          {lineCount} lines
        </span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 ml-auto" />
        ) : (
          <ChevronRight className="h-3 w-3 ml-auto" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-blue-500/20 px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap max-h-60 overflow-y-auto font-mono">
          {content}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const { settings } = useSettings();
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const isExpanded = expanded ?? settings.thinkingExpanded;

  return (
    <div className="rounded border border-purple-500/20 bg-purple-500/5">
      <button
        onClick={() => setExpanded(!isExpanded)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-purple-400 hover:text-purple-300"
      >
        <Brain className="h-3 w-3" />
        <span className="font-medium">Thinking</span>
        <span className="text-muted-foreground ml-1">
          {text.length.toLocaleString()} chars
        </span>
        {isExpanded ? (
          <ChevronDown className="h-3 w-3 ml-auto" />
        ) : (
          <ChevronRight className="h-3 w-3 ml-auto" />
        )}
      </button>
      {isExpanded && (
        <div className="border-t border-purple-500/20 px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap max-h-60 overflow-y-auto">
          {text}
        </div>
      )}
    </div>
  );
}
