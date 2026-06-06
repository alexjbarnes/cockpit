"use client";

import { Bot, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ChatView } from "./chat-view";

interface AssistantModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AssistantModal({ open, onOpenChange }: AssistantModalProps) {
  const sessionIdRef = useRef<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string>("");
  const _sessionCreatedRef = useRef(false);

  // Reset error when modal opens
  useEffect(() => {
    if (open) {
      setError(null);
    }
  }, [open]);

  // Create or reconnect session
  useEffect(() => {
    if (!open) return;

    const existingId = sessionIdRef.current;
    if (existingId) {
      // Reuse existing session
      setSessionId(existingId);
      return;
    }

    let cancelled = false;
    setLoading(true);

    async function init() {
      try {
        const res = await fetch("/api/assistant-session");
        if (!res.ok) throw new Error("Failed to initialize assistant");
        const { sessionId: newId, cwd: cockpitCwd } = await res.json();
        if (!cancelled) {
          sessionIdRef.current = newId;
          setSessionId(newId);
          setCwd(cockpitCwd);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to initialize");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // On close, keep the session alive in the ref but reset display state
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        // Session persists — keep sessionIdRef.current
        setSessionId(null);
      }
      onOpenChange(newOpen);
    },
    [onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-3xl h-[80vh] flex flex-col p-0 gap-0 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b shrink-0">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Cockpit Assistant</span>
          <button
            type="button"
            onClick={() => handleOpenChange(false)}
            aria-label="Close assistant"
            className="ml-auto rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col">
          {loading && (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {error && <div className="flex items-center justify-center h-full text-sm text-muted-foreground px-4">{error}</div>}
          {sessionId && !loading && !error && <ChatView sessionId={sessionId} cwd={cwd} showPlanToggle={false} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
