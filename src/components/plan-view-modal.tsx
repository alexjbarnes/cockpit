"use client";

import { useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { pathBasename } from "@/lib/path";
import rehypeHighlight from "rehype-highlight";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MarkdownCodeBlock } from "@/components/markdown-code-block";

const markdownComponents = { pre: MarkdownCodeBlock };

interface PlanViewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  content: string;
  filePath: string;
}

export function PlanViewModal({ open, onOpenChange, content, filePath }: PlanViewModalProps) {
  const onClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  if (!open) return null;

  const basename = pathBasename(filePath) || filePath;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={handleOverlayClick}
    >
      <Card className="w-full max-w-3xl flex flex-col" style={{ maxHeight: "calc(100dvh - 2rem)" }}>
        <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
          <span className="text-sm font-medium text-muted-foreground">{basename}</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 message-prose prose prose-sm max-w-none dark:prose-invert">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={markdownComponents}
          >
            {content}
          </ReactMarkdown>
        </div>
      </Card>
    </div>
  );
}
