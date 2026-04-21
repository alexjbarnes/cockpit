"use client";

import { Brain, ChevronDown, ChevronRight, File, FileText, Loader2 } from "lucide-react";
import React, { memo, useCallback, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { languageFromPath, CodeBlock as SyntaxCodeBlock } from "@/components/code-block";
import { MarkdownCodeBlock } from "@/components/markdown-code-block";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useSettings } from "@/hooks/use-settings";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types";
import { ToolCard } from "./tool-card";

const CLI_XML_RE =
  /<(?:task-notification|local-command-caveat|local-command-stdout|command-name|system-reminder)[^>]*>[\s\S]*?<\/(?:task-notification|local-command-caveat|local-command-stdout|command-name|system-reminder)>[\s\S]*/g;

function stripCliXml(text: string): string {
  return text.replace(CLI_XML_RE, "").trim();
}

const markdownComponents = { pre: MarkdownCodeBlock };

interface MessageBubbleProps {
  message: ChatMessage;
  collapsedByDefault?: boolean;
  expandedToolIds?: React.RefObject<Set<string>>;
  selectionMode?: boolean;
  selected?: boolean;
  onEnterSelection?: (messageId: string) => void;
  onToggleSelect?: (messageId: string) => void;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  collapsedByDefault = false,
  expandedToolIds,
  selectionMode = false,
  selected = false,
  onEnterSelection,
  onToggleSelect,
}: MessageBubbleProps) {
  const [collapsed, setCollapsed] = useState(collapsedByDefault);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isSelectable = !isSystem;
  const hiddenTools = new Set(["AskUserQuestion", "TodoWrite"]);
  const visibleBlocks = message.blocks?.filter((b) => !(b.type === "tool_use" && hiddenTools.has(b.toolUse.name))) || [];
  const hasBlocks = visibleBlocks.length > 0;

  const lastInputWasTouch = useRef(false);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);

  // Right-click: only toggle selection when already in selection mode
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (lastInputWasTouch.current) return;
      if (!selectionMode) return;
      e.preventDefault();
      if (isSelectable) onToggleSelect?.(message.id);
    },
    [isSelectable, selectionMode, message.id, onToggleSelect],
  );

  const handleTouchStart = useCallback(() => {
    lastInputWasTouch.current = true;
  }, []);

  const handleMouseDown = useCallback(() => {
    lastInputWasTouch.current = false;
  }, []);

  // Double-tap/click enters message selection (touch + desktop)
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
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
    },
    [selectionMode, isSelectable, message.id, onToggleSelect, onEnterSelection],
  );

  if (isSystem) {
    const isCompacting = message.content === "__compacting__";
    const isCompacted = message.content === "__compacted__";

    if (isCompacting || isCompacted) {
      return (
        <div className="flex w-full items-center gap-3 py-2">
          <div className="flex-1 border-t border-border" />
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
            {isCompacting && <Loader2 className="h-3 w-3 animate-spin" />}
            {isCompacting ? "Compacting..." : "Compacted"}
          </div>
          <div className="flex-1 border-t border-border" />
        </div>
      );
    }

    if (message.content === "__context_reset__") {
      return (
        <div className="flex w-full items-center gap-3 py-2">
          <div className="flex-1 border-t border-border" />
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Context cleared</div>
          <div className="flex-1 border-t border-border" />
        </div>
      );
    }

    return (
      <div className="flex w-full justify-center">
        <div className="text-xs text-muted-foreground whitespace-pre-wrap py-1">{message.content}</div>
      </div>
    );
  }

  // Skip empty assistant bubbles (e.g. message only had AskUserQuestion)
  if (!isUser && !isSystem && !hasBlocks && !message.content && message.toolUses.every((t) => hiddenTools.has(t.name))) {
    return null;
  }

  // Hide CLI-injected interrupt markers (e.g. after exiting plan mode)
  if (isUser && message.content.startsWith("[Request interrupted")) {
    return null;
  }

  if (collapsed) {
    const _preview = message.content.slice(0, 80).replace(/\n/g, " ");
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
        selectionMode && "cursor-pointer select-none",
      )}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-4 py-2 overflow-hidden transition-colors",
          isUser && !collapsedByDefault ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
          selected && "ring-2 ring-blue-500",
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
                    className="max-h-60 rounded border border-primary-foreground/20 object-contain cursor-pointer"
                    alt=""
                    onClick={(e) => {
                      e.stopPropagation();
                      setPreviewSrc(`data:${img.mediaType};base64,${img.data}`);
                    }}
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
            {message.content && <p className="whitespace-pre-wrap break-words text-base leading-relaxed">{message.content}</p>}
          </>
        ) : hasBlocks ? (
          <div className="space-y-2">
            {visibleBlocks.map((block, i) =>
              block.type === "tool_use" ? (
                <ToolCard key={block.toolUse.id} tool={block.toolUse} expandedToolIds={expandedToolIds} />
              ) : block.type === "thinking" ? (
                <ThinkingBlock
                  key={`thinking-${i}`}
                  text={block.text}
                  tokens={block.tokens}
                  durationMs={block.durationMs}
                  redacted={block.redacted}
                />
              ) : (
                <div key={`text-${i}`} className="message-prose prose prose-sm max-w-none dark:prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                    {stripCliXml(block.text)}
                  </ReactMarkdown>
                </div>
              ),
            )}
          </div>
        ) : (
          <>
            {message.toolUses.filter((t) => !hiddenTools.has(t.name)).length > 0 && (
              <div className="mb-2 space-y-1">
                {message.toolUses
                  .filter((t) => !hiddenTools.has(t.name))
                  .map((tool) => (
                    <ToolCard key={tool.id} tool={tool} expandedToolIds={expandedToolIds} />
                  ))}
              </div>
            )}
            <div className="message-prose prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                {stripCliXml(message.content)}
              </ReactMarkdown>
            </div>
          </>
        )}
      </div>
      <Dialog open={previewSrc !== null} onOpenChange={() => setPreviewSrc(null)} className="max-w-3xl">
        <DialogContent className="max-h-[80vh] overflow-auto" onClose={() => setPreviewSrc(null)}>
          {previewSrc && <img src={previewSrc} className="w-full rounded object-contain" alt="" />}
        </DialogContent>
      </Dialog>
    </div>
  );
});

function TextFileBlock({ name, content }: { name: string; content: string }) {
  const [open, setOpen] = useState(false);
  const lineCount = content.split("\n").length;

  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className="flex w-full items-center gap-1.5 rounded border border-blue-500/20 bg-blue-500/5 px-3 py-1.5 text-xs text-blue-400 hover:text-blue-300"
      >
        <File className="h-3 w-3" />
        <span className="font-medium">{name}</span>
        <span className="text-muted-foreground ml-1">{lineCount} lines</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col" onClose={() => setOpen(false)}>
          <div className="text-sm font-medium px-1 pb-2 border-b border-border flex items-center gap-1.5">
            <File className="h-3.5 w-3.5 text-blue-400" />
            {name}
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            <SyntaxCodeBlock code={content} language={languageFromPath(name)} dark />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ThinkingBlock({ text, tokens, durationMs }: { text: string; tokens?: number; durationMs?: number; redacted?: boolean }) {
  const { settings } = useSettings();
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const isExpanded = expanded ?? settings.thinkingExpanded;
  const hasText = text.length > 0;
  const sizeLabel =
    durationMs != null
      ? `${Math.max(1, Math.round(durationMs / 1000))}s`
      : tokens != null
        ? `${tokens.toLocaleString()} token${tokens === 1 ? "" : "s"}`
        : hasText
          ? `${text.length.toLocaleString()} chars`
          : null;

  return (
    <div className="rounded border border-purple-500/20 bg-purple-500/5">
      <button
        onClick={() => hasText && setExpanded(!isExpanded)}
        disabled={!hasText}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-purple-400 hover:text-purple-300 disabled:cursor-default disabled:hover:text-purple-400"
      >
        <Brain className="h-3 w-3" />
        <span className="font-medium">Thinking</span>
        {sizeLabel && <span className="text-muted-foreground ml-1">{sizeLabel}</span>}
        {hasText && (isExpanded ? <ChevronDown className="h-3 w-3 ml-auto" /> : <ChevronRight className="h-3 w-3 ml-auto" />)}
      </button>
      {hasText && isExpanded && (
        <div className="border-t border-purple-500/20 px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap max-h-60 overflow-y-auto">
          {text}
        </div>
      )}
    </div>
  );
}
