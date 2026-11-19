"use client";

import { GitPullRequest, LayoutGrid, Plus, Square, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { type SidebarSectionConfig, useShell } from "@/components/app-shell";
import { useSessionWatch } from "@/components/session-watch-provider";
import { SidebarFilesChanges } from "@/components/sidebar-files-changes";
import { SidebarSection } from "@/components/sidebar-section";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/hooks/use-settings";
import { useWebSocket } from "@/hooks/use-websocket";
import { type NewSessionInput, newSessionBody } from "@/lib/new-session";
import { createStaleGuard } from "@/lib/stale-guard";
import { addUnreadSession, clearUnreadSession, getUnreadSessions } from "@/lib/unread-sessions";
import { cn } from "@/lib/utils";
import type { SessionInfo } from "@/types";
import { NewSessionDialog } from "./new-session-dialog";

const SIDEBAR_WIDTH_KEY = "cockpit_sidebar_width";
const DEFAULT_WIDTH = 288; // 18rem = w-72
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

function getSavedWidth(): number {
  try {
    const v = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (v) {
      const n = parseInt(v, 10);
      if (n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
    }
  } catch {}
  return DEFAULT_WIDTH;
}

function SidebarResizeHandle({ onResize }: { onResize: (delta: number) => void }) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      lastX.current = e.clientX;

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const delta = ev.clientX - lastX.current;
        lastX.current = ev.clientX;
        onResize(delta);
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [onResize],
  );

  return (
    <div
      onMouseDown={onMouseDown}
      className="hidden md:block absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-primary/30 transition-colors z-10"
    />
  );
}

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

async function fetchPinnedIds(): Promise<string[]> {
  try {
    const res = await fetch("/api/sessions/pinned");
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.pinned) ? data.pinned : [];
  } catch {
    return [];
  }
}

// Server-side pinned reviews API helpers
const pinListeners = new Set<() => void>();

export function onPinChange(cb: () => void): () => void {
  pinListeners.add(cb);
  return () => {
    pinListeners.delete(cb);
  };
}

export async function pinReview(id: string): Promise<void> {
  await fetch("/api/reviews/pinned", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ add: id }),
  }).catch(() => {});
  for (const cb of pinListeners) cb();
}

async function unpinReview(id: string): Promise<void> {
  await fetch("/api/reviews/pinned", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ remove: id }),
  }).catch(() => {});
}

async function fetchPinnedReviewIds(): Promise<string[]> {
  try {
    const res = await fetch("/api/reviews/pinned");
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.pinned) ? data.pinned : [];
  } catch {
    return [];
  }
}

interface ReviewSession {
  id: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  status: "idle" | "running";
  pendingRequestCount: number;
}

const REVIEW_NAME_RE = /^Review:\s*(?:(.+?)\/)?(.+?)#(\d+)(?:\s+-\s+(.*))?$/;

function parseReviewSession(s: SessionInfo): ReviewSession | null {
  const match = REVIEW_NAME_RE.exec(s.name);
  if (!match) return null;
  return {
    id: s.id,
    owner: match[1] || "",
    repo: match[2],
    number: parseInt(match[3], 10),
    title: match[4] || "",
    status: s.status,
    pendingRequestCount: s.pendingRequestCount ?? 0,
  };
}

export interface SidebarHandle {
  toggle: () => void;
  close: () => void;
}

// The session list reads by session, not by folder. Each folder is a header
// once; a row leads with the session's name and says in words when it is working or waiting for you;
// the order is most recent activity first; "remove from sidebar" and "stop" are separate quiet buttons.

/** The folder's own name: the last part of its path. */
function folderName(cwd: string): string {
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

/** Cockpit names a session after its folder until the conversation has a title of its own. */
function displayName(session: SessionInfo): string {
  const name = session.name?.trim();
  return !name || name === folderName(session.cwd) ? "New session" : name;
}

function timeAgo(ms: number): string {
  if (!ms) return "";
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

interface FolderGroup {
  cwd: string;
  sessions: SessionInfo[];
  lastActiveAt: number;
}

/** The pinned sessions by folder: the most recently active folder first, and in each folder the most
 *  recently active session first. Status is not part of the order, so rows do not jump while you aim at
 *  them; a session that is working or waiting is recent anyway. */
function groupByFolder(sessions: SessionInfo[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>();
  for (const s of sessions) {
    const g = groups.get(s.cwd) ?? { cwd: s.cwd, sessions: [], lastActiveAt: 0 };
    g.sessions.push(s);
    g.lastActiveAt = Math.max(g.lastActiveAt, s.lastActiveAt || 0);
    groups.set(s.cwd, g);
  }
  const list = [...groups.values()];
  for (const g of list) g.sessions.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
  return list.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

function FolderHeader({ cwd }: { cwd: string }) {
  return (
    <div className="flex items-baseline gap-1.5 px-3 pt-2.5 pb-0.5 text-xs min-w-0" title={cwd}>
      <span className="shrink-0 font-semibold text-foreground/80">{folderName(cwd)}</span>
      <span className="truncate text-muted-foreground/70" dir="rtl">
        <bdo dir="ltr">{cwd}</bdo>
      </span>
    </div>
  );
}

function SessionRow({
  session,
  isCurrent,
  isUnread,
  onNavigate,
  onDismiss,
  onStop,
}: {
  session: SessionInfo;
  isCurrent: boolean;
  isUnread: boolean;
  onNavigate: (s: SessionInfo) => void;
  onDismiss: (e: React.MouseEvent, s: SessionInfo) => void;
  onStop: (e: React.MouseEvent, s: SessionInfo) => void;
}) {
  const pending = (session.pendingRequestCount ?? 0) > 0;
  const running = session.status === "running";
  const agents = session.agentCount ?? 0;
  const name = displayName(session);

  let dot: React.ReactNode;
  let label: string | null = null;
  let labelClass = "text-muted-foreground";
  if (pending) {
    dot = (
      <>
        <div className="absolute h-4 w-4 rounded-full bg-blue-500/20 animate-ping" />
        <div className="h-2.5 w-2.5 rounded-full bg-blue-500" title="Awaiting your input" data-testid="status-pending" />
      </>
    );
    label = "Waiting for you";
    labelClass = "text-blue-500 font-medium";
  } else if (running) {
    dot = (
      <>
        <div className="absolute h-4 w-4 rounded-full bg-yellow-500/20 animate-ping" />
        <div className="h-2.5 w-2.5 rounded-full bg-yellow-500" title="Working" data-testid="status-running" />
      </>
    );
    label = "Working";
    labelClass = "text-yellow-600 dark:text-yellow-500";
  } else if (agents > 0) {
    // Idle but not finished: the turn ended while agents it launched keep
    // working. Pulsing, not pinging, to read as background work — the
    // session takes input in this state.
    dot = (
      <div
        className="h-2.5 w-2.5 rounded-full bg-yellow-500/50 animate-pulse"
        title={`${agents} background agent${agents === 1 ? "" : "s"} working`}
        data-testid="status-agents"
      />
    );
    label = `${agents} background agent${agents === 1 ? "" : "s"} working`;
    labelClass = "text-yellow-600 dark:text-yellow-500";
  } else if (isUnread) {
    dot = <div className="h-2.5 w-2.5 rounded-full bg-green-500" title="New response" data-testid="status-unread" />;
    label = "New reply";
    labelClass = "text-green-600 dark:text-green-500";
  } else {
    dot = <div className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" data-testid="status-idle" />;
  }

  // On wide screens the buttons show on hover or keyboard focus; on phones, which have no hover, always.
  const quietButton = "h-7 w-7 shrink-0 text-muted-foreground md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onNavigate(session)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onNavigate(session);
        }
      }}
      title={`${name}\n${session.cwd}`}
      className={cn(
        "group w-full flex items-center gap-2 pl-4 pr-1.5 py-1.5 text-left text-sm hover:bg-accent/50 transition-colors cursor-pointer",
        isCurrent && "bg-accent",
      )}
      data-testid="sidebar-session-row"
    >
      <div className="shrink-0 relative flex items-center justify-center h-4 w-4">{dot}</div>
      <div className="flex-1 min-w-0">
        <div className={cn("truncate text-left", isCurrent ? "font-semibold" : "font-medium")}>{name}</div>
        <div className={cn("truncate text-xs", labelClass)}>{label ?? timeAgo(session.lastActiveAt)}</div>
      </div>
      {running ? (
        <Button
          variant="ghost"
          size="icon"
          className={cn(quietButton, "hover:text-red-600 hover:bg-red-500/10")}
          onClick={(e) => onStop(e, session)}
          title="Stop session"
          aria-label="Stop session"
        >
          <Square className="h-3.5 w-3.5" />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className={cn(quietButton, "hover:text-foreground")}
          onClick={(e) => onDismiss(e, session)}
          title="Remove from sidebar"
          aria-label="Remove from sidebar"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

export const Sidebar = forwardRef<SidebarHandle>(function Sidebar(_props, ref) {
  const router = useRouter();
  const pathname = usePathname();
  const { subscribe, connected } = useWebSocket();
  const { sidebarSections, cwd } = useShell();
  const { settings } = useSettings();
  // Settings changed inside the modal apply here as soon as it closes.
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [reviewWatchIds, setReviewWatchIds] = useState<string[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  useEffect(() => {
    setWidth(getSavedWidth());
  }, []);

  useEffect(() => {
    router.prefetch("/sessions/_");
  }, [router]);

  const handleResize = useCallback((delta: number) => {
    setWidth((prev) => {
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, prev + delta));
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
      return next;
    });
  }, []);

  const prevStatusRef = useRef<Map<string, string>>(new Map());
  const staleGuard = useRef(createStaleGuard()).current;

  useImperativeHandle(
    ref,
    () => ({
      toggle: () => setOpen((prev) => !prev),
      close: () => setOpen(false),
    }),
    [],
  );

  const close = useCallback(() => setOpen(false), []);

  const currentSessionId = pathname.startsWith("/sessions/") ? pathname.split("/")[2] : null;

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === "session:status") {
        const { sessionId, status } = msg;
        if (!sessions.some((s) => s.id === sessionId)) return; // the assistant's session, or another page's
        const prev = prevStatusRef.current.get(sessionId);
        prevStatusRef.current.set(sessionId, status);
        if (prev === "running" && status === "idle" && sessionId !== currentSessionId) {
          addUnreadSession(sessionId);
          setUnread(getUnreadSessions());
        }
        setSessions((list) => list.map((s) => (s.id === sessionId ? { ...s, status: status as SessionInfo["status"] } : s)));
      } else if (msg.type === "session:pending") {
        const { sessionId, count } = msg;
        if (!sessions.some((s) => s.id === sessionId)) return;
        setSessions((list) => list.map((s) => (s.id === sessionId ? { ...s, pendingRequestCount: count } : s)));
      } else if (msg.type === "session:agents") {
        const { sessionId, count } = msg;
        setSessions((list) => list.map((s) => (s.id === sessionId ? { ...s, agentCount: count } : s)));
      } else if (msg.type === "session:info_updated") {
        const { sessionId, info } = msg;
        setSessions((list) => list.map((s) => (s.id === sessionId ? { ...s, name: info.name, model: info.model } : s)));
      }
    });
  }, [subscribe, currentSessionId, sessions]);

  const fetchSessions = useCallback(async () => {
    // The effects below can start a second run while the first is still waiting
    // on by-ids, whose transcript scan slows down as the pinned list grows. The
    // guard makes the newest run win: without it the response order decided,
    // and a run that started before a session was created would land last and
    // overwrite the list that had it — the new session showed up in the sidebar
    // and then disappeared until the page was refreshed.
    const isStale = staleGuard.begin();
    setUnread(getUnreadSessions());

    const pinnedIds = await fetchPinnedIds();
    if (isStale()) return;
    if (pinnedIds.length === 0) {
      setSessions([]);
      return;
    }

    const idsParam = pinnedIds.join(",");
    const res = await fetch(`/api/sessions/by-ids?ids=${encodeURIComponent(idsParam)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    if (!res || isStale()) return;

    const fetchedSessions: SessionInfo[] = (res.sessions || []).filter((s: SessionInfo) => !s.cwd.endsWith(".cockpit/reviews"));

    // Preserve the user's pinned ordering. A pin whose session this response
    // does not carry is left in the file and simply not rendered here: the
    // response can come back partial (a transcript being written, a scan
    // racing a server start, a session whose id moved on /clear), and deleting
    // from one of those lost the user's whole pinned list. Pins are removed
    // where they are removed deliberately: closing or deleting a session.
    const byId = new Map(fetchedSessions.map((s) => [s.id, s]));
    const visible: SessionInfo[] = [];
    for (const id of pinnedIds) {
      const s = byId.get(id);
      if (s) visible.push(s);
    }

    for (const s of visible) {
      if (!prevStatusRef.current.has(s.id)) {
        prevStatusRef.current.set(s.id, s.status);
      }
    }
    setSessions(visible);
  }, [staleGuard]);

  // Fetch immediately on mount so pinned sessions appear without waiting
  // for the WebSocket connection to establish.
  const hasFetchedRef = useRef(false);
  useEffect(() => {
    if (!hasFetchedRef.current) {
      hasFetchedRef.current = true;
      fetchSessions();
    }
  }, [fetchSessions]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname triggers refetch on navigation
  useEffect(() => {
    if (open || connected) {
      fetchSessions();
    }
  }, [open, connected, pathname, fetchSessions]);

  // One watch list per connection: the server replaces everything it watches
  // when a `session:subscribe` arrives, so the review rows' ids are merged here
  // through the shell's single sender rather than sent separately.
  const watchedIds = useMemo(() => [...sessions.map((s) => s.id), ...reviewWatchIds], [sessions, reviewWatchIds]);
  useSessionWatch("sidebar", watchedIds);

  const stopSession = async (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    // Stopping ends the Claude process mid-turn, so it asks first.
    if (!window.confirm(`Stop "${name}"?\n\nIts Claude process ends now. The conversation is kept and can be resumed.`)) {
      return;
    }
    const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (res.ok) {
      await unpinSession(id);
      clearUnreadSession(id);
      setUnread(getUnreadSessions());
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (currentSessionId === id) router.push("/");
    }
  };

  const dismissSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await unpinSession(id);
    clearUnreadSession(id);
    setUnread(getUnreadSessions());
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (currentSessionId === id) router.push("/");
  };

  const createSession = async (input: NewSessionInput): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newSessionBody(input)),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return { ok: false, error: typeof data.error === "string" ? data.error : "Could not create the session" };
      }
      const data = await res.json();
      await pinSession(data.sessionId);
      await fetchSessions();
      close();
      router.push(`/sessions/${data.sessionId}?cwd=${encodeURIComponent(input.cwd.trim())}`);
      return { ok: true };
    } catch {
      return { ok: false, error: "Failed to connect" };
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

  const watchReviewIds = useCallback((ids: string[]) => setReviewWatchIds(ids), []);

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/50 transition-opacity md:hidden",
          open ? "opacity-100" : "opacity-0 pointer-events-none",
        )}
        onMouseDown={close}
        data-testid="sidebar-backdrop"
      />

      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 bg-background border-r flex flex-col transition-transform duration-200",
          "md:relative md:inset-auto md:z-auto md:translate-x-0 md:shrink-0 md:transition-none",
          open ? "translate-x-0" : "-translate-x-full",
        )}
        style={{ width }}
      >
        <SidebarResizeHandle onResize={handleResize} />
        <div className="flex items-center justify-end px-3 py-1 border-b md:hidden">
          <Button variant="ghost" size="icon" onClick={close} data-testid="sidebar-close" aria-label="Close sidebar">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="hidden md:block">
            <SidebarSection
              id="sessions"
              title="Sessions"
              badge={sessions.length > 0 ? String(sessions.length) : undefined}
              actions={
                <div className="flex items-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => setDialogOpen(true)}
                    title="New session"
                    data-testid="sidebar-new-session"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => {
                      close();
                      router.push("/");
                    }}
                    title="All sessions"
                  >
                    <LayoutGrid className="h-3 w-3" />
                  </Button>
                </div>
              }
            >
              {sessions.length === 0 ? (
                <p className="px-3 py-3 text-sm text-muted-foreground">No active sessions.</p>
              ) : (
                <div className="pb-1">
                  {groupByFolder(sessions).map((group) => (
                    <div key={group.cwd} data-testid="sidebar-folder-group">
                      <FolderHeader cwd={group.cwd} />
                      {group.sessions.map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          isCurrent={currentSessionId === session.id}
                          isUnread={unread.has(session.id)}
                          onNavigate={navigateToSession}
                          onDismiss={(e, s) => dismissSession(e, s.id)}
                          onStop={(e, s) => stopSession(e, s.id, displayName(s))}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </SidebarSection>
          </div>

          <div className="hidden md:block">
            <DynamicSections sections={sidebarSections} exclude={REVIEW_ADJACENT_SECTIONS} />
          </div>

          {cwd && <SidebarFilesChanges cwd={cwd} />}

          {settings.reviewsEnabled && (
            <div className="hidden md:block">
              <RecentReviewsSection onNavigate={close} onWatchIds={watchReviewIds} />
            </div>
          )}

          {settings.reviewsEnabled && (
            <SidebarSection
              id="pr-files"
              title={sidebarSections.get("pr-files")?.title || "PR Files"}
              badge={sidebarSections.get("pr-files")?.badge}
              defaultOpen={false}
            >
              {sidebarSections.has("pr-files") ? (
                sidebarSections.get("pr-files")!.content
              ) : (
                <div className="px-3 py-3 text-xs text-muted-foreground">No PR open</div>
              )}
            </SidebarSection>
          )}
        </div>
      </div>

      <NewSessionDialog open={dialogOpen} onOpenChange={setDialogOpen} onSubmit={createSession} />
    </>
  );
});

function RecentReviewsSection({ onNavigate, onWatchIds }: { onNavigate: () => void; onWatchIds: (ids: string[]) => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const { subscribe } = useWebSocket();
  const [reviews, setReviews] = useState<ReviewSession[]>([]);

  const fetchReviews = useCallback(async () => {
    const pinnedIds = await fetchPinnedReviewIds();
    if (pinnedIds.length === 0) {
      setReviews([]);
      return;
    }

    const res = await fetch(`/api/sessions/by-ids?ids=${encodeURIComponent(pinnedIds.join(","))}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (!res) return;

    const sessions: SessionInfo[] = res.sessions || [];

    // Same rule as the sessions above: a review pin the response does not
    // carry is left in the file rather than deleted from one partial answer.
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const visible: ReviewSession[] = [];
    for (const id of pinnedIds) {
      const s = byId.get(id);
      if (s) {
        const parsed = parseReviewSession(s);
        if (parsed) visible.push(parsed);
      }
    }

    setReviews(visible);

    // The sidebar sends the one watch list for the whole connection; these ids
    // go into it rather than being sent from here.
    onWatchIds(visible.map((r) => r.id));
  }, [onWatchIds]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname triggers refetch on navigation
  useEffect(() => {
    fetchReviews();
  }, [pathname, fetchReviews]);

  useEffect(() => {
    return () => onWatchIds([]);
  }, [onWatchIds]);

  useEffect(() => {
    return onPinChange(() => fetchReviews());
  }, [fetchReviews]);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === "session:status") {
        const { sessionId, status } = msg;
        setReviews((list) => list.map((r) => (r.id === sessionId ? { ...r, status: status as ReviewSession["status"] } : r)));
      } else if (msg.type === "session:pending") {
        const { sessionId, count } = msg;
        setReviews((list) => list.map((r) => (r.id === sessionId ? { ...r, pendingRequestCount: count } : r)));
      }
    });
  }, [subscribe]);

  const goToReview = (r: ReviewSession) => {
    onNavigate();
    if (r.owner) {
      router.push(`/reviews/${r.owner}/${r.repo}/${r.number}`);
    } else {
      router.push("/reviews");
    }
  };

  const removeReview = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setReviews((list) => list.filter((r) => r.id !== id));
    unpinReview(id);
  };

  return (
    <SidebarSection
      id="reviews"
      title="Reviews"
      badge={reviews.length > 0 ? String(reviews.length) : undefined}
      actions={
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => {
            onNavigate();
            router.push("/reviews");
          }}
          title="All reviews"
        >
          <GitPullRequest className="h-3 w-3" />
        </Button>
      }
    >
      {reviews.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">No pinned reviews.</p>
      ) : (
        reviews.map((r) => (
          <div
            key={r.id}
            role="button"
            tabIndex={0}
            onClick={() => goToReview(r)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                goToReview(r);
              }
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50 transition-colors cursor-pointer"
          >
            <div className="shrink-0 relative flex items-center justify-center h-4 w-4">
              {r.pendingRequestCount > 0 ? (
                <>
                  <div className="absolute h-4 w-4 rounded-full bg-blue-500/20 animate-ping" />
                  <div className="h-2.5 w-2.5 rounded-full bg-blue-500" title="Awaiting input" />
                </>
              ) : r.status === "running" ? (
                <>
                  <div className="absolute h-4 w-4 rounded-full bg-yellow-500/20 animate-ping" />
                  <div className="h-2.5 w-2.5 rounded-full bg-yellow-500" title="Working" />
                </>
              ) : (
                <div className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="truncate font-medium">
                {r.repo}#{r.number}
              </div>
              {r.title && <div className="truncate text-xs text-muted-foreground">{r.title}</div>}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-red-500 hover:text-red-600 hover:bg-red-500/10"
              onClick={(e) => removeReview(e, r.id)}
              title="Remove"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))
      )}
    </SidebarSection>
  );
}

const REVIEW_ADJACENT_SECTIONS = new Set(["pr-files"]);

function DynamicSections({ sections, exclude }: { sections: Map<string, SidebarSectionConfig>; exclude?: Set<string> }) {
  const sorted = useMemo(
    () =>
      Array.from(sections.values())
        .filter((s) => !exclude?.has(s.id))
        .sort((a, b) => (a.order ?? 50) - (b.order ?? 50)),
    [sections, exclude],
  );

  return (
    <>
      {sorted.map((section) => (
        <SidebarSection key={section.id} id={section.id} title={section.title} badge={section.badge} actions={section.actions}>
          {section.content}
        </SidebarSection>
      ))}
    </>
  );
}
