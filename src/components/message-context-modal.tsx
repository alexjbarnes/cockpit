"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MessageBubble } from "./message-bubble";
import { useShell } from "./app-shell";
import type { ChatMessage } from "@/types";

interface MessageContextModalProps {
  timestamp: number;
  onClose: () => void;
}

export function MessageContextModal({ timestamp, onClose }: MessageContextModalProps) {
  const { sessionId, cwd } = useShell();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [targetId, setTargetId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const expandedToolIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const params = new URLSearchParams({ timestamp: String(timestamp) });
    if (cwd) params.set("cwd", cwd);

    fetch(`/api/sessions/${sessionId}/context?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load context");
        return res.json();
      })
      .then((data) => {
        setMessages(data.messages);
        setTargetId(data.targetMessageId);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [sessionId, cwd, timestamp]);

  useEffect(() => {
    if (!loading && targetRef.current) {
      targetRef.current.scrollIntoView({ block: "center" });
    }
  }, [loading]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={handleOverlayClick}>
      <Card className="w-full max-w-3xl flex flex-col" style={{ maxHeight: "calc(100dvh - 2rem)" }}>
        <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
          <span className="text-sm font-medium text-muted-foreground">Message context</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {loading && (
            <div className="flex justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {error && (
            <div className="text-center text-sm text-red-500 py-12">{error}</div>
          )}
          {!loading && messages.map((msg) => (
            <div
              key={msg.id}
              ref={msg.id === targetId ? targetRef : undefined}
              className={msg.id === targetId ? "ring-2 ring-primary/50 rounded-lg" : undefined}
            >
              <MessageBubble
                message={msg}
                expandedToolIds={expandedToolIds}
              />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
