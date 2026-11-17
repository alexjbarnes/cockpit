"use client";

import { Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageBubble } from "@/components/message-bubble";
import { Button } from "@/components/ui/button";
import { useWebSocket } from "@/hooks/use-websocket";
import { atLatest } from "@/lib/agent-transcript";
import type { ChatMessage } from "@/types";

/** How often a peek re-reads a session that is still working. */
const PEEK_POLL_MS = 3000;

/**
 * A look at what a session is doing, over the page rather than instead of it:
 * its latest messages, read-only, following along while it works. Used from an
 * issue's workflow card to see what the agent there is up to without leaving
 * the issue.
 */
export function SessionPeekModal({
  sessionId,
  cwd,
  label,
  running,
  onClose,
}: {
  sessionId: string;
  cwd?: string;
  label: string;
  running: boolean;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { send, connected } = useWebSocket();

  // A peek is looking at the session, so a turn ending now must not raise the
  // banner or a push. Reported like the session page reports itself, and
  // cleared on close and while the tab is hidden.
  useEffect(() => {
    const report = () => send({ type: "session:set_peeking", sessionId, peeking: document.visibilityState === "visible" });
    report();
    document.addEventListener("visibilitychange", report);
    return () => {
      document.removeEventListener("visibilitychange", report);
      send({ type: "session:set_peeking", sessionId, peeking: false });
    };
  }, [sessionId, send]);

  // The server keeps this per connection, so a reconnect starts out peeking at
  // nothing; say it again, as the session page does for itself.
  useEffect(() => {
    if (connected) send({ type: "session:set_peeking", sessionId, peeking: document.visibilityState === "visible" });
  }, [connected, sessionId, send]);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/transcript?${params}`);
      if (!res.ok) throw new Error("Couldn't load the session");
      setMessages(((await res.json()) as { messages?: ChatMessage[] }).messages ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId, cwd]);

  useEffect(() => {
    void load();
    if (!running) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, PEEK_POLL_MS);
    return () => clearInterval(timer);
  }, [load, running]);

  // Take focus from the page underneath: left in a composer, the Escape that
  // closes this would also reach it.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Opens at the latest message and follows along until the reader scrolls up.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    let following = true;
    const observer = new ResizeObserver(() => {
      if (following) scroller.scrollTop = scroller.scrollHeight;
    });
    const onScroll = () => {
      following = atLatest(scroller);
    };
    observer.observe(content);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.scrollTop = scroller.scrollHeight;
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Peek: ${label}`}
        className="flex h-full w-full flex-col overflow-hidden bg-background outline-none sm:h-[85dvh] sm:max-w-4xl sm:rounded-lg sm:border sm:shadow-lg"
        data-testid="session-peek"
      >
        <div className="flex shrink-0 items-start gap-2 border-b px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="font-mono text-sm font-medium">{label}</span>
            {running && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />}
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} title="Close" data-testid="session-peek-close">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3" data-testid="session-peek-scroll">
          <div ref={contentRef} className="space-y-4">
            {messages?.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {messages && messages.length === 0 && (
              <p className="text-xs italic text-muted-foreground" data-testid="session-peek-empty">
                Nothing has been said yet.
              </p>
            )}
            {messages === null && !error && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading the session…
              </div>
            )}
            {error && <p className="text-xs text-red-500">{error}</p>}
            {running && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="session-peek-working">
                <Loader2 className="h-3 w-3 animate-spin" />
                Still working
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
