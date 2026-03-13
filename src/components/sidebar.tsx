"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import type { SessionInfo, SessionGroup } from "@/types";
import { useWebSocket } from "@/hooks/use-websocket";
import { NewSessionDialog } from "./new-session-dialog";
import { cn } from "@/lib/utils";
import { Plus, Home, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const ACTIVE_KEY = "aperture_active_sessions";
const UNREAD_KEY = "aperture_unread_sessions";

export function getActiveSessions(): Set<string> {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

export function addActiveSession(id: string): void {
  const set = getActiveSessions();
  set.add(id);
  localStorage.setItem(ACTIVE_KEY, JSON.stringify([...set]));
}

function removeActiveSession(id: string): void {
  const set = getActiveSessions();
  set.delete(id);
  localStorage.setItem(ACTIVE_KEY, JSON.stringify([...set]));
}

function getUnreadSessions(): Set<string> {
  try {
    const raw = localStorage.getItem(UNREAD_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

function addUnreadSession(id: string): void {
  const set = getUnreadSessions();
  set.add(id);
  localStorage.setItem(UNREAD_KEY, JSON.stringify([...set]));
}

export function clearUnreadSession(id: string): void {
  const set = getUnreadSessions();
  set.delete(id);
  localStorage.setItem(UNREAD_KEY, JSON.stringify([...set]));
}

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

function shortPath(cwd: string): string {
  const parts = cwd.split("/");
  return parts.length > 2 ? "~/" + parts.slice(-2).join("/") : cwd;
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { send, subscribe, connected } = useWebSocket();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);

  // Track which sessions were "running" so we can detect transitions
  const prevStatusRef = useRef<Map<string, string>>(new Map());

  const currentSessionId = pathname.startsWith("/sessions/")
    ? pathname.split("/")[2]
    : null;

  // Subscribe to WebSocket messages for live status and info updates
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === "session:status") {
        const { sessionId, status } = msg;
        if (!getActiveSessions().has(sessionId)) return;

        const prev = prevStatusRef.current.get(sessionId);
        prevStatusRef.current.set(sessionId, status);

        if (prev === "running" && status === "idle" && currentSessionId !== sessionId) {
          addUnreadSession(sessionId);
          setUnread(getUnreadSessions());
        }

        setSessions((list) =>
          list.map((s) =>
            s.id === sessionId ? { ...s, status: status as SessionInfo["status"] } : s
          )
        );
      } else if (msg.type === "session:info_updated") {
        const { sessionId, info } = msg;
        setSessions((list) =>
          list.map((s) =>
            s.id === sessionId ? { ...s, name: info.name, model: info.model } : s
          )
        );
      }
    });
  }, [subscribe, currentSessionId]);

  const fetchSessions = useCallback(async () => {
    const activeIds = getActiveSessions();
    setUnread(getUnreadSessions());
    if (activeIds.size === 0) {
      setSessions([]);
      return;
    }
    let res: Response;
    try {
      res = await fetch("/api/sessions");
    } catch {
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    const groups: SessionGroup[] = data.groups || [];
    const flat = groups
      .flatMap((g) => g.sessions)
      .filter((s) => activeIds.has(s.id))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    // Seed prev status tracking
    for (const s of flat) {
      if (!prevStatusRef.current.has(s.id)) {
        prevStatusRef.current.set(s.id, s.status);
      }
    }
    // Clean up IDs that no longer exist on server
    const serverIds = new Set(flat.map((s) => s.id));
    for (const id of activeIds) {
      if (!serverIds.has(id)) removeActiveSession(id);
    }
    setSessions(flat);

    // Subscribe to status updates for all active sessions
    if (flat.length > 0) {
      send({ type: "session:subscribe", sessionIds: flat.map((s) => s.id) });
    }
  }, [send]);

  // Fetch on open and on WebSocket reconnection
  useEffect(() => {
    if (open || connected) {
      fetchSessions();
    }
  }, [open, connected, fetchSessions]);

  const stopSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (res.ok) {
      removeActiveSession(id);
      clearUnreadSession(id);
      setUnread(getUnreadSessions());
      setSessions((prev) => prev.filter((s) => s.id !== id));
    }
  };

  const dismissSession = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    removeActiveSession(id);
    clearUnreadSession(id);
    setUnread(getUnreadSessions());
    setSessions((prev) => prev.filter((s) => s.id !== id));
  };

  const createSession = async (cwd: string, name: string) => {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, name: name || undefined }),
    });
    if (res.ok) {
      const data = await res.json();
      addActiveSession(data.sessionId);
      onClose();
      router.push(`/sessions/${data.sessionId}?cwd=${encodeURIComponent(cwd)}`);
    }
  };

  const navigateToSession = (session: SessionInfo) => {
    clearUnreadSession(session.id);
    setUnread(getUnreadSessions());
    onClose();
    router.push(`/sessions/${session.id}?cwd=${encodeURIComponent(session.cwd)}`);
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/50 transition-opacity",
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-72 bg-background border-r flex flex-col transition-transform duration-200",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-sm font-bold">Active Sessions</span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDialogOpen(true)}
              title="New session"
            >
              <Plus className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Session list */}
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {sessions.map((session) => (
            <div
              key={session.id}
              role="button"
              tabIndex={0}
              onClick={() => navigateToSession(session)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigateToSession(session);
                }
              }}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50 transition-colors cursor-pointer",
                currentSessionId === session.id && "bg-accent"
              )}
            >
              {/* Status indicator */}
              <div className="shrink-0 relative flex items-center justify-center h-4 w-4">
                {session.status === "running" ? (
                  <>
                    <div className="absolute h-4 w-4 rounded-full bg-yellow-500/20 animate-ping" />
                    <div className="h-2.5 w-2.5 rounded-full bg-yellow-500" title="Working" />
                  </>
                ) : unread.has(session.id) ? (
                  <div className="h-2.5 w-2.5 rounded-full bg-blue-500" title="New response" />
                ) : (
                  <div className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="truncate font-medium">{session.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {shortPath(session.cwd)}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                onClick={(e) =>
                  session.status === "running"
                    ? stopSession(e, session.id)
                    : dismissSession(e, session.id)
                }
                title={session.status === "running" ? "Stop session" : "Remove from sidebar"}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {sessions.length === 0 && (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              No active sessions.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-3 py-2">
          <button
            onClick={() => {
              onClose();
              router.push("/");
            }}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full"
          >
            <Home className="h-4 w-4" />
            All sessions
          </button>
        </div>
      </div>

      <NewSessionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={createSession}
      />
    </>
  );
}
