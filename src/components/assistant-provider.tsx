"use client";

import { usePathname } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AssistantModal } from "@/components/assistant-modal";
import { useSessionWatch } from "@/components/session-watch-provider";
import { useWebSocket } from "@/hooks/use-websocket";
import { type AssistantDot, assistantDot } from "@/lib/assistant-dot";
import { createStaleGuard } from "@/lib/stale-guard";
import { addUnreadSession, clearUnreadSession, getUnreadSessions } from "@/lib/unread-sessions";

/** The assistant's session as its dot needs it. It is an ordinary session,
 *  just never pinned into the sidebar. */
interface AssistantStatus {
  id: string;
  status: "idle" | "running";
  pendingRequestCount: number;
}

interface AssistantContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  openAssistant: () => void;
  dot: AssistantDot | null;
  sessionId: string | null;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

/**
 * The Cockpit Assistant, owned by the shell rather than the sidebar: the
 * navigation opens it from any page, so its session, unread state and modal
 * live here. It watches its own session for status and pending changes, and
 * marks a turn that ends unseen as unread in the shared set.
 */
export function AssistantProvider({ children }: { children: ReactNode }) {
  const { subscribe, connected } = useWebSocket();
  const pathname = usePathname();
  const [assistant, setAssistant] = useState<AssistantStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(false);
  const staleGuard = useRef(createStaleGuard()).current;
  const prevStatus = useRef<Map<string, string>>(new Map());
  const openRef = useRef(open);
  openRef.current = open;

  const refreshUnread = useCallback(() => {
    setUnread((prev) => {
      const next = getUnreadSessions();
      const value = assistant ? next.has(assistant.id) : false;
      return value === prev ? prev : value;
    });
  }, [assistant]);

  const fetchAssistant = useCallback(async () => {
    const isStale = staleGuard.begin();
    const res = await fetch("/api/assistant-status")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (!res || isStale()) return;
    if (!res.sessionId) {
      setAssistant(null);
      setUnread(false);
      return;
    }
    const id: string = res.sessionId;
    if (!prevStatus.current.has(id)) prevStatus.current.set(id, res.status);
    setAssistant({ id, status: res.status, pendingRequestCount: res.pendingRequestCount ?? 0 });
    setUnread(getUnreadSessions().has(id));
  }, [staleGuard]);

  // Fetch on mount so the dot is right before the socket connects, and again
  // after a reconnect or a navigation.
  useEffect(() => {
    fetchAssistant();
  }, [fetchAssistant]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname triggers a refetch on navigation
  useEffect(() => {
    if (connected) fetchAssistant();
  }, [connected, pathname, fetchAssistant]);

  useEffect(() => {
    return subscribe((msg) => {
      if (!assistant) return;
      const isAssistant = (id: string) => id === assistant.id;
      if (msg.type === "session:status") {
        if (!isAssistant(msg.sessionId)) return;
        const prev = prevStatus.current.get(msg.sessionId);
        prevStatus.current.set(msg.sessionId, msg.status);
        if (prev === "running" && msg.status === "idle" && !openRef.current) {
          addUnreadSession(msg.sessionId);
          setUnread(true);
        }
        setAssistant((a) => (a && a.id === msg.sessionId ? { ...a, status: msg.status } : a));
      } else if (msg.type === "session:pending") {
        if (!isAssistant(msg.sessionId)) return;
        setAssistant((a) => (a && a.id === msg.sessionId ? { ...a, pendingRequestCount: msg.count } : a));
      }
    });
  }, [subscribe, assistant]);

  // Keep the assistant's session watched on every page: the sidebar, which
  // used to watch it, only exists beside a session now.
  useSessionWatch("assistant", assistant ? [assistant.id] : []);

  const openAssistant = useCallback(() => {
    if (assistant) {
      clearUnreadSession(assistant.id);
      setUnread(false);
    }
    setOpen(true);
  }, [assistant]);

  // The modal's first open creates the session; until then nothing knew its id.
  const handleAssistantSession = useCallback(
    (id: string) => {
      setAssistant((prev) => (prev?.id === id ? prev : { id, status: "idle", pendingRequestCount: 0 }));
      refreshUnread();
    },
    [refreshUnread],
  );

  const dot = useMemo(
    () => (assistant ? assistantDot({ status: assistant.status, pendingRequestCount: assistant.pendingRequestCount, unread }) : null),
    [assistant, unread],
  );

  const value = useMemo<AssistantContextValue>(
    () => ({ open, setOpen, openAssistant, dot, sessionId: assistant?.id ?? null }),
    [open, openAssistant, dot, assistant],
  );

  return (
    <AssistantContext.Provider value={value}>
      {children}
      <AssistantModal open={open} onOpenChange={setOpen} onSession={handleAssistantSession} />
    </AssistantContext.Provider>
  );
}

export function useAssistant(): AssistantContextValue {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used inside AssistantProvider");
  return ctx;
}
