"use client";

import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CalendarClock,
  Check,
  ExternalLink,
  FileEdit,
  FileMinus,
  FilePlus,
  FileSymlink,
  GitPullRequest,
  GripVertical,
  Inbox,
  LayoutGrid,
  Plus,
  Settings,
  X,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { type SidebarSectionConfig, useShell } from "@/components/app-shell";
import { FilePicker } from "@/components/file-picker";
import { FileTree } from "@/components/file-tree";
import { SidebarSection } from "@/components/sidebar-section";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useJobFailureCount } from "@/hooks/use-jobs";
import { useSettings } from "@/hooks/use-settings";
import { useWebSocket } from "@/hooks/use-websocket";
import { useCheckedFiles } from "@/lib/checked-files";
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
  const parts = cwd.split(/[/\\]/);
  return parts.length > 2 ? "~/" + parts.slice(-2).join("/") : cwd;
}

function SortableSessionRow({
  session,
  isCurrent,
  isUnread,
  onNavigate,
  onAction,
}: {
  session: SessionInfo;
  isCurrent: boolean;
  isUnread: boolean;
  onNavigate: (s: SessionInfo) => void;
  onAction: (e: React.MouseEvent, s: SessionInfo) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: session.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      role="button"
      tabIndex={0}
      onClick={() => onNavigate(session)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onNavigate(session);
        }
      }}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50 transition-colors cursor-pointer",
        isCurrent && "bg-accent",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        className="shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/60 hover:text-muted-foreground touch-none"
        title="Drag to reorder"
        aria-label="Drag to reorder"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="shrink-0 relative flex items-center justify-center h-4 w-4">
        {(session.pendingRequestCount ?? 0) > 0 ? (
          <>
            <div className="absolute h-4 w-4 rounded-full bg-blue-500/20 animate-ping" />
            <div className="h-2.5 w-2.5 rounded-full bg-blue-500" title="Awaiting your input" data-testid="status-pending" />
          </>
        ) : session.status === "running" ? (
          <>
            <div className="absolute h-4 w-4 rounded-full bg-yellow-500/20 animate-ping" />
            <div className="h-2.5 w-2.5 rounded-full bg-yellow-500" title="Working" data-testid="status-running" />
          </>
        ) : isUnread ? (
          <div className="h-2.5 w-2.5 rounded-full bg-green-500" title="New response" data-testid="status-unread" />
        ) : (
          <div className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" data-testid="status-idle" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate font-medium text-left" dir="rtl" title={session.cwd}>
          <bdo dir="ltr">{shortPath(session.cwd)}</bdo>
        </div>
        <div className="truncate text-xs text-muted-foreground">{session.name}</div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 text-red-500 hover:text-red-600 hover:bg-red-500/10"
        onClick={(e) => onAction(e, session)}
        title={session.status === "running" ? "Stop session" : "Remove from sidebar"}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

export const Sidebar = forwardRef<SidebarHandle>(function Sidebar(_props, ref) {
  const router = useRouter();
  const pathname = usePathname();
  const { send, subscribe, connected } = useWebSocket();
  const { sidebarSections, cwd, sessionId: shellSessionId } = useShell();
  const { settings } = useSettings();
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [unread, setUnread] = useState<Set<string>>(new Set());
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

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 150, tolerance: 5 },
    }),
  );

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
        // Accept status updates for any session we're showing (pinned or running)
        const known = new Set(sessions.map((s) => s.id));
        if (!known.has(sessionId)) {
          console.log(
            "[sidebar] status update for unknown session",
            sessionId.slice(0, 8),
            "known:",
            [...known].map((s) => s.slice(0, 8)),
          );
          return;
        }
        console.log("[sidebar] status updated", sessionId.slice(0, 8), "->", status);

        const prev = prevStatusRef.current.get(sessionId);
        prevStatusRef.current.set(sessionId, status);

        if (prev === "running" && status === "idle" && currentSessionId !== sessionId) {
          addUnreadSession(sessionId);
          setUnread(getUnreadSessions());
        }

        setSessions((list) => list.map((s) => (s.id === sessionId ? { ...s, status: status as SessionInfo["status"] } : s)));
      } else if (msg.type === "session:pending") {
        const { sessionId, count } = msg;
        const known = new Set(sessions.map((s) => s.id));
        if (!known.has(sessionId)) {
          console.log("[sidebar] pending update for unknown session", sessionId.slice(0, 8));
          return;
        }
        console.log("[sidebar] pending updated", sessionId.slice(0, 8), "->", count);
        setSessions((list) => list.map((s) => (s.id === sessionId ? { ...s, pendingRequestCount: count } : s)));
      } else if (msg.type === "session:info_updated") {
        const { sessionId, info } = msg;
        setSessions((list) => list.map((s) => (s.id === sessionId ? { ...s, name: info.name, model: info.model } : s)));
      }
    });
  }, [subscribe, currentSessionId, sessions]);

  const fetchSessions = useCallback(async () => {
    setUnread(getUnreadSessions());

    const pinnedIds = await fetchPinnedIds();
    if (pinnedIds.length === 0) {
      setSessions([]);
      return;
    }

    const idsParam = pinnedIds.join(",");
    const res = await fetch(`/api/sessions/by-ids?ids=${encodeURIComponent(idsParam)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    if (!res) return;

    const fetchedSessions: SessionInfo[] = (res.sessions || []).filter((s: SessionInfo) => !s.cwd.endsWith(".cockpit/reviews"));
    const foundIds: string[] = Array.isArray(res.foundIds) ? res.foundIds : fetchedSessions.map((s) => s.id);
    const foundSet = new Set(foundIds);

    // Preserve the user's pinned ordering
    const byId = new Map(fetchedSessions.map((s) => [s.id, s]));
    const visible: SessionInfo[] = [];
    const survivingIds: string[] = [];
    for (const id of pinnedIds) {
      const s = byId.get(id);
      if (s) {
        visible.push(s);
        survivingIds.push(id);
      }
    }

    // Drop pins whose session files no longer exist (server confirms via foundIds)
    const hasOrphans = pinnedIds.some((id) => !foundSet.has(id));
    if (hasOrphans) {
      fetch("/api/sessions/pinned", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: survivingIds }),
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname triggers refetch on navigation
  useEffect(() => {
    if (open || connected) {
      fetchSessions();
    }
  }, [open, connected, pathname, fetchSessions]);

  const stopSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
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

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = sessions.findIndex((s) => s.id === active.id);
      const newIndex = sessions.findIndex((s) => s.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;

      const next = arrayMove(sessions, oldIndex, newIndex);
      setSessions(next);
      fetch("/api/sessions/pinned", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: next.map((s) => s.id) }),
      }).catch((err) => console.error("Failed to persist sidebar order", err));
    },
    [sessions],
  );

  const createSession = async (cwd: string, name: string, runtime: "pty" | "stream") => {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, name: name || undefined, runtime }),
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
          open ? "opacity-100" : "opacity-0 pointer-events-none",
        )}
        onMouseDown={close}
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
          <Button variant="ghost" size="icon" onClick={close}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <SidebarSection
            id="sessions"
            title="Sessions"
            badge={sessions.length > 0 ? String(sessions.length) : undefined}
            actions={
              <div className="flex items-center">
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setDialogOpen(true)} title="New session">
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
              <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
                <SortableContext items={sessions.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                  {sessions.map((session) => (
                    <SortableSessionRow
                      key={session.id}
                      session={session}
                      isCurrent={currentSessionId === session.id}
                      isUnread={unread.has(session.id)}
                      onNavigate={navigateToSession}
                      onAction={(e, s) => (s.status === "running" ? stopSession(e, s.id) : dismissSession(e, s.id))}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            )}
          </SidebarSection>

          <DynamicSections sections={sidebarSections} exclude={REVIEW_ADJACENT_SECTIONS} />

          {cwd && !sidebarSections.has("git-changes") && <SidebarChanges cwd={cwd} sessionId={shellSessionId} />}

          {cwd && !sidebarSections.has("file-tree") && <SidebarFileTree cwd={cwd} />}

          {settings.reviewsEnabled && <RecentReviewsSection onNavigate={close} />}

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

        <div className="border-t px-3 py-2 flex items-center justify-end gap-2">
          <JobsButton
            onClick={() => {
              close();
              router.push("/jobs");
            }}
          />
          <InboxButton
            onClick={() => {
              close();
              router.push("/inbox");
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => {
              sessionStorage.removeItem("settings-scroll");
              close();
              router.push("/settings");
            }}
            title="Settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <NewSessionDialog open={dialogOpen} onOpenChange={setDialogOpen} onSubmit={createSession} />
    </>
  );
});

function RecentReviewsSection({ onNavigate }: { onNavigate: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const { subscribe, send } = useWebSocket();
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
    const foundIds: string[] = Array.isArray(res.foundIds) ? res.foundIds : sessions.map((s: SessionInfo) => s.id);
    const foundSet = new Set(foundIds);

    const byId = new Map(sessions.map((s) => [s.id, s]));
    const visible: ReviewSession[] = [];
    const survivingIds: string[] = [];
    for (const id of pinnedIds) {
      const s = byId.get(id);
      if (s) {
        const parsed = parseReviewSession(s);
        if (parsed) visible.push(parsed);
        survivingIds.push(id);
      }
    }

    if (pinnedIds.some((id) => !foundSet.has(id))) {
      fetch("/api/reviews/pinned", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: survivingIds }),
      }).catch(() => {});
    }

    setReviews(visible);

    if (visible.length > 0) {
      send({ type: "session:subscribe", sessionIds: visible.map((r) => r.id) });
    }
  }, [send]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname triggers refetch on navigation
  useEffect(() => {
    fetchReviews();
  }, [pathname, fetchReviews]);

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

function isMobile() {
  return typeof window !== "undefined" && window.innerWidth < 768;
}

function SidebarFileTree({ cwd }: { cwd: string }) {
  const router = useRouter();
  const { tabActions, closeSidebar } = useShell();
  const [pickerOpen, setPickerOpen] = useState(false);

  const handleSelect = useCallback(
    (filePath: string) => {
      if (tabActions) {
        tabActions.openFile(filePath);
      } else {
        router.push(`/files?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(filePath)}`);
      }
      if (isMobile()) closeSidebar();
    },
    [router, cwd, tabActions, closeSidebar],
  );

  const handlePickFile = useCallback(
    (filePath: string) => {
      handleSelect(filePath);
      setPickerOpen(false);
    },
    [handleSelect],
  );

  return (
    <SidebarSection
      id="files"
      title="Session Files"
      defaultOpen={false}
      actions={
        <button
          onClick={() => setPickerOpen(true)}
          title="Open file"
          className="flex items-center justify-center rounded p-0.5 hover:bg-accent text-muted-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      }
    >
      <FileTree cwd={cwd} selectedFile={null} onSelectFile={handleSelect} />
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Open File</DialogTitle>
          </DialogHeader>
          <FilePicker startPath={cwd} onSelect={handlePickFile} onCancel={() => setPickerOpen(false)} />
        </DialogContent>
      </Dialog>
    </SidebarSection>
  );
}

function changeStatusIcon(status: string) {
  switch (status) {
    case "added":
    case "untracked":
      return <FilePlus className="h-3.5 w-3.5 text-green-500" />;
    case "deleted":
      return <FileMinus className="h-3.5 w-3.5 text-red-500" />;
    case "renamed":
      return <FileSymlink className="h-3.5 w-3.5 text-blue-500" />;
    default:
      return <FileEdit className="h-3.5 w-3.5 text-yellow-500" />;
  }
}

function SidebarChanges({ cwd, sessionId }: { cwd: string; sessionId?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const { tabActions } = useShell();
  const { subscribe } = useWebSocket();
  const { checkedFiles, toggleFile } = useCheckedFiles(cwd);
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<Array<{ path: string; status: string; additions: number; deletions: number }>>([]);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  const fetchStatus = useCallback(() => {
    fetch(`/api/git/status?cwd=${encodeURIComponent(cwdRef.current)}`)
      .then((r) => {
        if (!r.ok) throw new Error("Not a git repository");
        return r.json();
      })
      .then((data) => {
        setFiles(data.files || []);
        setBranch(data.branch || "");
        setError(null);
      })
      .catch((err) => {
        setFiles([]);
        setBranch("");
        setError(err instanceof Error ? err.message : "Failed to load");
      });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname triggers refetch on navigation
  useEffect(() => {
    fetchStatus();
  }, [cwd, pathname, fetchStatus]);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== "session:fs_changed") return;
      fetchStatus();
    });
  }, [subscribe, fetchStatus]);

  const sessionParam = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : "";
  const totalAdded = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeleted = files.reduce((sum, f) => sum + f.deletions, 0);

  return (
    <SidebarSection
      id="session-changes"
      title="Session Changes"
      badge={files.length > 0 ? String(files.length) : undefined}
      defaultOpen={false}
    >
      {error ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">{error}</p>
      ) : files.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">Working tree clean</p>
      ) : (
        <>
          <div className="px-3 py-1.5 text-xs text-muted-foreground flex items-center gap-2 border-b">
            {branch && (
              <>
                <span>Branch:</span>
                <span className="font-mono font-bold text-foreground">{branch}</span>
                <span className="mx-0.5">·</span>
              </>
            )}
            <span>{files.length} changed</span>
            {totalAdded > 0 && <span className="text-green-500">+{totalAdded}</span>}
            {totalDeleted > 0 && <span className="text-red-500">-{totalDeleted}</span>}
            <div className="flex-1" />
            <button
              type="button"
              title="Open commit view"
              onClick={() => {
                if (tabActions) {
                  tabActions.openChanges();
                } else {
                  router.push(`/changes?cwd=${encodeURIComponent(cwd)}${sessionParam}`);
                }
              }}
              className="hover:text-foreground transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          </div>
          {files.map((file) => (
            <div key={file.path} className="flex items-center gap-1 px-3 py-1 text-xs hover:bg-accent/50 transition-colors">
              <button
                type="button"
                role="checkbox"
                aria-checked={checkedFiles.has(file.path)}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFile(file.path);
                }}
                className={cn(
                  "h-3.5 w-3.5 shrink-0 rounded-full border flex items-center justify-center transition-colors",
                  checkedFiles.has(file.path)
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/30 bg-transparent hover:border-muted-foreground/50",
                )}
              >
                {checkedFiles.has(file.path) && <Check className="h-2 w-2" strokeWidth={3} />}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (tabActions) {
                    tabActions.openDiff(file.path);
                  } else {
                    router.push(`/changes?cwd=${encodeURIComponent(cwd)}${sessionParam}`);
                  }
                }}
                className="flex items-center gap-2 flex-1 min-w-0 text-left"
              >
                {changeStatusIcon(file.status)}
                <span className="font-mono truncate flex-1 min-w-0">{file.path}</span>
                <span className="shrink-0 flex gap-1 text-[10px] font-mono">
                  {file.additions > 0 && <span className="text-green-500">+{file.additions}</span>}
                  {file.deletions > 0 && <span className="text-red-500">-{file.deletions}</span>}
                </span>
              </button>
            </div>
          ))}
        </>
      )}
    </SidebarSection>
  );
}

function JobsButton({ onClick }: { onClick: () => void }) {
  const { count } = useJobFailureCount();

  return (
    <Button
      variant="ghost"
      size="icon"
      className="shrink-0 h-8 w-8 text-muted-foreground hover:text-foreground relative"
      onClick={onClick}
      title="Scheduled Jobs"
    >
      <CalendarClock className="h-4 w-4" />
      {count > 0 && <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500" />}
    </Button>
  );
}

function InboxButton({ onClick }: { onClick: () => void }) {
  const [unread, setUnread] = useState(0);
  const pathname = usePathname();

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname triggers refetch on navigation
  useEffect(() => {
    const check = () => {
      fetch("/api/inbox?count=true")
        .then((r) => r.json())
        .then((d) => setUnread(d.unread || 0))
        .catch(() => {});
    };
    check();
    const interval = setInterval(check, 15_000);
    return () => clearInterval(interval);
  }, [pathname]);

  return (
    <Button
      variant="ghost"
      size="icon"
      className="shrink-0 h-8 w-8 text-muted-foreground hover:text-foreground relative"
      onClick={onClick}
      title="Inbox"
    >
      <Inbox className="h-4 w-4" />
      {unread > 0 && <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-blue-500" />}
    </Button>
  );
}
