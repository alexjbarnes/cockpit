"use client";

import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, GripVertical, LayoutGrid, Loader2, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { NewSessionDialog } from "@/components/new-session-dialog";
import { useSessionWatch } from "@/components/session-watch-provider";
import { pinSession } from "@/components/sidebar";
import { Button } from "@/components/ui/button";
import { useWebSocket } from "@/hooks/use-websocket";
import { type NewSessionInput, newSessionBody } from "@/lib/new-session";
import { clearUnreadSession, getUnreadSessions } from "@/lib/unread-sessions";
import type { SessionInfo } from "@/types";

/** One pinned row, draggable by its handle. Tap still opens the session: the
 *  activator waits for a short hold, and only the handle starts a drag, so the
 *  rest of the row keeps the page's scrolling. */
function SortablePinnedRow({
  session,
  isUnread,
  onOpen,
  onUnpin,
}: {
  session: SessionInfo;
  isUnread: boolean;
  onOpen: (session: SessionInfo) => void;
  onUnpin: (e: React.MouseEvent, id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: session.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(session)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(session);
        }
      }}
      className="flex w-full cursor-pointer items-center gap-2 border-b px-3 py-3 text-left last:border-b-0 hover:bg-accent/50"
      data-testid={`pinned-session-${session.id}`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        className="shrink-0 cursor-grab touch-none rounded p-0.5 text-muted-foreground/60 hover:text-muted-foreground active:cursor-grabbing"
        title="Drag to reorder"
        aria-label="Drag to reorder"
        data-testid={`pinned-drag-${session.id}`}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
          (session.pendingRequestCount ?? 0) > 0
            ? "bg-blue-500"
            : session.status === "running"
              ? "bg-yellow-500"
              : isUnread
                ? "bg-green-500"
                : "bg-muted-foreground/30"
        }`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium" title={session.cwd}>
          {session.cwd.replace(/^\/home\/[^/]+/, "~")}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{session.name}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 text-red-500 hover:bg-red-500/10 hover:text-red-600"
        aria-label="Remove from pinned sessions"
        title="Remove from pinned sessions"
        data-testid={`unpin-session-${session.id}`}
        onClick={(e) => void onUnpin(e, session.id)}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

/**
 * The Sessions page: the pinned sessions, in the order they are pinned. It is
 * what the Sessions item opens, on a phone as much as a desktop; the folder
 * overview of every session is one button away.
 */
export default function PinnedSessionsPage() {
  usePageHeader("Sessions", { usageOnly: true });
  const router = useRouter();
  const { connected } = useWebSocket();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /** The pins as the server has them, including ones this page filters out
   *  (review sessions), so a reorder writes those back rather than dropping
   *  them. */
  const pinnedIdsRef = useRef<string[]>([]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { delay: 150, tolerance: 5 } }));

  const fetchPinned = useCallback(async () => {
    const ids = await fetch("/api/sessions/pinned")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const list: string[] = ids?.pinned ?? [];
    pinnedIdsRef.current = list;
    if (list.length === 0) {
      setSessions([]);
      setLoaded(true);
      return;
    }
    const res = await fetch(`/api/sessions/by-ids?ids=${encodeURIComponent(list.join(","))}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (!res) return;
    const byId = new Map<string, SessionInfo>((res.sessions ?? []).map((x: SessionInfo) => [x.id, x]));
    setSessions(list.map((id) => byId.get(id)).filter((x): x is SessionInfo => !!x && !x.cwd.endsWith(".cockpit/reviews")));
    setUnread(getUnreadSessions());
    setLoaded(true);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: connected refetches after a reconnect
  useEffect(() => {
    void fetchPinned();
  }, [fetchPinned, connected]);

  useSessionWatch(
    "pinned-page",
    sessions.map((s) => s.id),
  );

  const open = (session: SessionInfo) => {
    clearUnreadSession(session.id);
    router.push(`/sessions/${session.id}?cwd=${encodeURIComponent(session.cwd)}`);
  };

  /** Off the pinned list; the session itself stays, in All sessions. */
  const unpin = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setSessions((prev) => prev.filter((x) => x.id !== id));
    await fetch("/api/sessions/pinned", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remove: id }),
    }).catch(() => {});
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
      // Keep pins this page cannot render in their place too, or a reorder
      // would delete them.
      const order = next.map((s) => s.id);
      const hidden = pinnedIdsRef.current.filter((id) => !order.includes(id));
      const pinned = [...order, ...hidden];
      pinnedIdsRef.current = pinned;
      fetch("/api/sessions/pinned", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned }),
      }).catch((err) => console.error("Failed to persist pinned order", err));
    },
    [sessions],
  );

  const create = async (input: NewSessionInput) => {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newSessionBody(input)),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setCreateError(typeof data.error === "string" ? data.error : "Could not create the session");
        return { ok: false };
      }
      const data = await res.json();
      await pinSession(data.sessionId);
      router.push(`/sessions/${data.sessionId}?cwd=${encodeURIComponent(input.cwd.trim())}`);
      return { ok: true };
    } catch {
      setCreateError("Failed to connect");
      return { ok: false };
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto space-y-4 pb-24">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => router.push("/")} data-testid="all-sessions">
            <LayoutGrid className="h-4 w-4 mr-1.5" />
            All sessions
          </Button>
          <span className="grow" />
          <Button size="sm" onClick={() => setDialogOpen(true)} data-testid="pinned-new-session">
            <Plus className="h-4 w-4 mr-1" />
            New session
          </Button>
        </div>

        {!loaded && (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}
        {loaded && sessions.length === 0 && (
          <p className="text-sm text-muted-foreground py-8 text-center" data-testid="pinned-empty">
            Nothing is pinned yet. Open a session from All sessions and pin it, or start one here.
          </p>
        )}
        {sessions.length > 0 && (
          <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
            <div className="rounded-lg border bg-card overflow-hidden" data-testid="pinned-list">
              <SortableContext items={sessions.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                {sessions.map((session) => (
                  <SortablePinnedRow key={session.id} session={session} isUnread={unread.has(session.id)} onOpen={open} onUnpin={unpin} />
                ))}
              </SortableContext>
            </div>
          </DndContext>
        )}
        {createError && <p className="text-sm text-destructive">{createError}</p>}
        {creating && <p className="text-xs text-muted-foreground">Starting the session…</p>}
      </div>

      <NewSessionDialog open={dialogOpen} onOpenChange={setDialogOpen} onSubmit={create} />
    </div>
  );
}
