"use client";

import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import type { SessionInfo, SessionGroup } from "@/types";
import { useWebSocket } from "@/hooks/use-websocket";
import { NewSessionDialog } from "./new-session-dialog";
import { cn } from "@/lib/utils";
import { Plus, Home, X, Settings, GitPullRequest } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useShell } from "@/components/app-shell";

const UNREAD_KEY = "cockpit_unread_sessions";

// Server-side pinned sessions API helpers
export async function pinSession(id: string): Promise<void> {
  await fetch("/api/sessions/pinned", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ add: id }),
  }).catch(() => {});
}

async function unpinSession(id: string): Promise<void> {
  await fetch("/api/sessions/pinned", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ remove: id }),
  }).catch(() => {});
}

async function fetchPinnedIds(): Promise<Set<string>> {
  try {
    const res = await fetch("/api/sessions/pinned");
    if (!res.ok) return new Set();
    const data = await res.json();
    return new Set(data.pinned || []);
  } catch {
    return new Set();
  }
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

export interface SidebarHandle {
  toggle: () => void;
  close: () => void;
}

function shortPath(cwd: string): string {
  const parts = cwd.split("/");
  return parts.length > 2 ? "~/" + parts.slice(-2).join("/") : cwd;
}

export const Sidebar = forwardRef<SidebarHandle>(function Sidebar(_props, ref) {
  const router = useRouter();
  const pathname = usePathname();
  const { send, subscribe, connected } = useWebSocket();
  const { sidebarContent } = useShell();
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);

  const prevStatusRef = useRef<Map<string, string>>(new Map());
  const pinnedRef = useRef<Set<string>>(new Set());

  useImperativeHandle(ref, () => ({
    toggle: () => setOpen((prev) => !prev),
    close: () => setOpen(false),
  }), []);

  const close = useCallback(() => setOpen(false), []);

  const currentSessionId = pathname.startsWith("/sessions/")
    ? pathname.split("/")[2]
    : null;

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === "session:status") {
        const { sessionId, status } = msg;
        // Accept status updates for any session we're showing (pinned or running)
        const known = new Set(sessions.map((s) => s.id));
        if (!known.has(sessionId)) return;

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
  }, [subscribe, currentSessionId, sessions]);

  const fetchSessions = useCallback(async () => {
    setUnread(getUnreadSessions());

    // Fetch pinned IDs from server and all sessions in parallel
    const [pinned, sessionsRes] = await Promise.all([
      fetchPinnedIds(),
      fetch("/api/sessions").then((r) => r.ok ? r.json() : null).catch(() => null),
    ]);
    pinnedRef.current = pinned;

    if (!sessionsRes) return;
    const groups: SessionGroup[] = sessionsRes.groups || [];
    const allSessions = groups
      .flatMap((g) => g.sessions)
      .filter((s) => !s.cwd.endsWith(".cockpit/reviews"));

    // Show union of pinned + running sessions
    const visible = allSessions
      .filter((s) => pinned.has(s.id) || s.status === "running")
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    // Clean up pinned IDs that no longer exist on server
    const serverIds = new Set(allSessions.map((s) => s.id));
    let needsCleanup = false;
    for (const id of pinned) {
      if (!serverIds.has(id)) {
        needsCleanup = true;
        pinned.delete(id);
      }
    }
    if (needsCleanup) {
      fetch("/api/sessions/pinned", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: [...pinned] }),
      }).catch(() => {});
    }

    for (const s of visible) {
      if (!prevStatusRef.current.has(s.id)) {
        prevStatusRef.current.set(s.id, s.status);
      }
    }
    setSessions(visible);

    if (visible.length > 0) {
      send({ type: "session:subscribe", sessionIds: visible.map((s) => s.id) });
    }
  }, [send]);

  useEffect(() => {
    if (open || connected) {
      fetchSessions();
    }
  }, [open, connected, fetchSessions]);

  const stopSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (res.ok) {
      await unpinSession(id);
      clearUnreadSession(id);
      setUnread(getUnreadSessions());
      setSessions((prev) => prev.filter((s) => s.id !== id));
    }
  };

  const dismissSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await unpinSession(id);
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
      await pinSession(data.sessionId);
      await fetchSessions();
      close();
      router.push(`/sessions/${data.sessionId}?cwd=${encodeURIComponent(cwd)}`);
    }
  };

  const navigateToSession = (session: SessionInfo) => {
    clearUnreadSession(session.id);
    setUnread(getUnreadSessions());
    close();
    const params = new URLSearchParams({ cwd: session.cwd });
    if (session.name) params.set("name", session.name);
    router.push(`/sessions/${session.id}?${params}`);
  };

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/50 transition-opacity md:hidden",
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onMouseDown={close}
      />

      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-72 bg-background border-r flex flex-col transition-transform duration-200",
          "md:static md:inset-auto md:z-auto md:translate-x-0 md:shrink-0 md:transition-none",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {sidebarContent ? (
          <>
            <div className="flex items-center justify-end px-3 py-2 border-b md:hidden">
              <Button variant="ghost" size="icon" onClick={close}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {sidebarContent}
            </div>
          </>
        ) : (
          <>
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
                <Button variant="ghost" size="icon" onClick={close} className="md:hidden">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

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
                  <div className="shrink-0 relative flex items-center justify-center h-4 w-4">
                    {session.status === "running" ? (
                      <>
                        <div className="absolute h-4 w-4 rounded-full bg-yellow-500/20 animate-ping" />
                        <div className="h-2.5 w-2.5 rounded-full bg-yellow-500" title="Working" />
                      </>
                    ) : unread.has(session.id) ? (
                      <div className="h-2.5 w-2.5 rounded-full bg-green-500" title="New response" />
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

          </>
        )}

        <div className="border-t px-3 py-2 flex items-center gap-2">
          <button
            onClick={() => {
              close();
              router.push("/");
            }}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors flex-1 min-w-0"
          >
            <Home className="h-4 w-4 shrink-0" />
            All sessions
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => {
              close();
              router.push("/reviews");
            }}
            title="Reviews"
          >
            <GitPullRequest className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => {
              close();
              router.push("/settings");
            }}
            title="Settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <NewSessionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={createSession}
      />
    </>
  );
});
