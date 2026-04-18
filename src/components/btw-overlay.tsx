"use client";

import { Loader2, MessageSquare, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";

interface BtwOverlayProps {
  question: string;
  answer: string | null;
  loading: boolean;
  error: string | null;
  onDismiss: () => void;
}

export function BtwOverlay({ question, answer, loading, error, onDismiss }: BtwOverlayProps) {
  return (
    <div className="fixed bottom-24 left-2 right-2 z-40 mx-auto max-w-md animate-in fade-in duration-200">
      <div className="rounded-lg border bg-background shadow-lg max-h-[60vh] flex flex-col">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <MessageSquare className="h-3.5 w-3.5" />
            <span>Side question</span>
          </div>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onDismiss}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="px-3 py-2 overflow-y-auto">
          <p className="text-sm font-medium mb-2">{question}</p>
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Thinking...</span>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {answer && (
            <div className="text-sm prose prose-sm dark:prose-invert max-w-none border-t pt-2">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
