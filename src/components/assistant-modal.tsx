"use client";

import { Loader2, MessageCircle } from "lucide-react";
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
        // Fetch cwd and settings
        const [cwdRes, settingsRes] = await Promise.all([fetch("/api/config/cwd"), fetch("/api/assistant-settings")]);

        if (!cwdRes.ok || !settingsRes.ok) {
          throw new Error("Failed to initialize assistant");
        }

        const { cwd: cockpitCwd } = await cwdRes.json();
        const settings = await settingsRes.json();

        // Create cockpit-agent session
        const sessionRes = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cwd: cockpitCwd,
            cockpitAgent: true,
            model: settings.model || "sonnet",
            thinkingLevel: settings.thinkingLevel || "high",
          }),
        });

        if (!sessionRes.ok) {
          throw new Error("Failed to create assistant session");
        }

        const { sessionId: newId } = await sessionRes.json();
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
      <DialogContent className="sm:max-w-3xl h-[80vh] flex flex-col p-0 gap-0">
        <div className="flex items-center gap-2 px-4 py-3 border-b shrink-0">
          <MessageCircle className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Cockpit Assistant</span>
        </div>
        <div className="flex-1 min-h-0">
          {loading && (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {error && <div className="flex items-center justify-center h-full text-sm text-muted-foreground px-4">{error}</div>}
          {sessionId && !loading && !error && <ChatView sessionId={sessionId} cwd={cwd} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
