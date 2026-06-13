"use client";

import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { SessionInfo } from "@/types";

interface SessionCardProps {
  session: SessionInfo;
  onClick: () => void;
  onDelete?: (e: React.MouseEvent) => void;
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

export function SessionCard({ session, onClick, onDelete }: SessionCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="w-full flex items-center gap-3 px-3 py-2 text-left rounded-md hover:bg-accent/50 transition-colors cursor-pointer group"
    >
      <span className="text-sm truncate flex-1">{session.name}</span>
      <div className="flex items-center gap-2 shrink-0">
        {session.status === "running" && (
          <Badge variant="default" className="text-xs">
            running
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">{timeAgo(session.lastActiveAt)}</span>
        {onDelete && session.status !== "running" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(e);
            }}
            className="p-1 rounded hover:bg-destructive/10 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
            title="Delete session"
          >
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
          </button>
        )}
      </div>
    </div>
  );
}
