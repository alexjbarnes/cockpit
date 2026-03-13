"use client";

import type { SessionInfo } from "@/types";
import { Badge } from "@/components/ui/badge";

interface SessionCardProps {
  session: SessionInfo;
  onClick: () => void;
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

export function SessionCard({ session, onClick }: SessionCardProps) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2 text-left rounded-md hover:bg-accent/50 transition-colors"
    >
      <span className="text-sm truncate flex-1">{session.name}</span>
      <div className="flex items-center gap-2 shrink-0">
        {session.status === "running" && (
          <Badge variant="default" className="text-xs">running</Badge>
        )}
        <span className="text-xs text-muted-foreground">{timeAgo(session.lastActiveAt)}</span>
      </div>
    </button>
  );
}
