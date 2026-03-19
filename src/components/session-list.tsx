"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import type { SessionInfo, SessionGroup } from "@/types";
import { useWebSocket } from "@/hooks/use-websocket";
import { SessionCard } from "./session-card";
import { NewSessionDialog } from "./new-session-dialog";
import { Button } from "@/components/ui/button";
import { Plus, ChevronRight, Star, Folder } from "lucide-react";

let cachedGroups: SessionGroup[] | null = null;

const FAVORITES_KEY = "cockpit_fav_dirs";

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

function saveFavorites(favs: Set<string>): void {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favs]));
}

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function DirectoryGroup({
  group,
  isFavorite,
  onToggleFavorite,
  onSelectSession,
}: {
  group: SessionGroup;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onSelectSession: (session: SessionInfo) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const latestAt = group.sessions[0]?.lastActiveAt || 0;
  const runningCount = group.sessions.filter((s) => s.status === "running").length;

  return (
    <div className="rounded-lg border bg-card">
      <div
        role="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 p-3 text-left hover:bg-accent/50 rounded-lg transition-colors cursor-pointer"
      >
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="font-medium text-sm truncate flex-1">{group.dirName}</span>
        <div className="flex items-center gap-2 shrink-0">
          {runningCount > 0 && (
            <span className="text-xs bg-primary text-primary-foreground px-1.5 py-0.5 rounded">
              {runningCount} running
            </span>
          )}
          <span className="text-xs text-muted-foreground">{timeAgo(latestAt)}</span>
          <span className="text-xs text-muted-foreground">
            {group.sessions.length}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite();
            }}
            className="p-1 rounded hover:bg-accent"
          >
            <Star
              className={`h-3.5 w-3.5 ${
                isFavorite ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"
              }`}
            />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="px-3 pb-3 space-y-1">
          {group.sessions.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              onClick={() => onSelectSession(s)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SessionList() {
  const router = useRouter();
  const { connected } = useWebSocket();
  const [groups, setGroups] = useState<SessionGroup[]>(cachedGroups || []);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const hasFetchedRef = useRef(false);

  useEffect(() => {
    setFavorites(loadFavorites());
  }, []);

  const fetchSessions = useCallback(async () => {
    const res = await fetch("/api/sessions");
    if (res.ok) {
      const data = await res.json();
      const fetched = data.groups || [];
      cachedGroups = fetched;
      setGroups(fetched);
    }
  }, []);

  useEffect(() => {
    if (!hasFetchedRef.current) {
      hasFetchedRef.current = true;
      fetchSessions();
    }
  }, [fetchSessions]);

  useEffect(() => {
    if (connected) {
      fetchSessions();
    }
  }, [connected, fetchSessions]);

  const toggleFavorite = (cwd: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) {
        next.delete(cwd);
      } else {
        next.add(cwd);
      }
      saveFavorites(next);
      return next;
    });
  };

  const createSession = async (cwd: string, name: string) => {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, name: name || undefined }),
    });
    if (res.ok) {
      const data = await res.json();
      router.push(`/sessions/${data.sessionId}?cwd=${encodeURIComponent(cwd)}`);
    }
  };

  const navigateToSession = (session: SessionInfo) => {
    router.push(`/sessions/${session.id}?cwd=${encodeURIComponent(session.cwd)}`);
  };

  const favoriteGroups = groups.filter((g) => favorites.has(g.cwd));
  const otherGroups = groups.filter((g) => !favorites.has(g.cwd));

  return (
    <div className="mx-auto max-w-lg p-4 space-y-3">
      <h1 className="text-2xl font-bold">Sessions</h1>

      {groups.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No sessions found. Create one to get started.
        </p>
      )}

      {favoriteGroups.map((group) => (
        <DirectoryGroup
          key={group.cwd}
          group={group}
          isFavorite
          onToggleFavorite={() => toggleFavorite(group.cwd)}
          onSelectSession={navigateToSession}
        />
      ))}

      {favoriteGroups.length > 0 && otherGroups.length > 0 && (
        <div className="border-t" />
      )}

      {otherGroups.map((group) => (
        <DirectoryGroup
          key={group.cwd}
          group={group}
          isFavorite={false}
          onToggleFavorite={() => toggleFavorite(group.cwd)}
          onSelectSession={navigateToSession}
        />
      ))}

      <div className="fixed bottom-6 right-6">
        <Button size="lg" className="rounded-full shadow-lg" onClick={() => setDialogOpen(true)}>
          <Plus className="h-5 w-5 mr-1" />
          New Session
        </Button>
      </div>
      <NewSessionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={createSession}
      />
    </div>
  );
}
