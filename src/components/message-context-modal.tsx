"use client";

import { ArrowUpRight, Loader2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ChatMessage } from "@/types";
import { useShell } from "./app-shell";
import { MessageBubble } from "./message-bubble";

interface MessageContextModalProps {
  timestamp: number;
  onClose: () => void;
  sessionId?: string;
  cwd?: string;
}

export function MessageContextModal(props: MessageContextModalProps) {
  const { timestamp, onClose } = props;
  const shell = useShell();
  const router = useRouter();
  const sessionId = props.sessionId ?? shell.sessionId;
  const cwd = props.cwd ?? shell.cwd;
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

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={handleOverlayClick}>
      <Card className="w-full max-w-3xl flex flex-col" style={{ maxHeight: "calc(100dvh - 2rem)" }}>
        <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
          <span className="text-sm font-medium text-muted-foreground">Message context</span>
          <div className="flex items-center gap-1">
            {props.sessionId && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                title="Open session"
                onClick={() => {
                  router.push(`/sessions/${sessionId}?cwd=${encodeURIComponent(cwd ?? "")}&historyView=true`);
                  onClose();
                }}
              >
                <ArrowUpRight className="h-3 w-3" />
                Open session
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {loading && (
            <div className="flex justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {error && <div className="text-center text-sm text-red-500 py-12">{error}</div>}
          {!loading &&
            messages.map((msg) => (
              <div
                key={msg.id}
                ref={msg.id === targetId ? targetRef : undefined}
                className={msg.id === targetId ? "ring-2 ring-primary/50 rounded-lg" : undefined}
              >
                <MessageBubble message={msg} expandedToolIds={expandedToolIds} />
              </div>
            ))}
        </div>
      </Card>
    </div>
  );
}
