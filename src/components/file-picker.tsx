"use client";

import { CornerLeftUp, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionFileTree } from "@/components/session-file-tree";
import { Button } from "@/components/ui/button";
import { absolutePath, type SessionPathListing } from "@/lib/session-tree";

interface FilePickerProps {
  onSelect: (path: string) => void;
  onCancel: () => void;
  startPath: string;
}

/** The parent of an absolute `/`-separated path, stopping at its root. */
function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  if (cut <= 0) return "/";
  const parent = trimmed.slice(0, cut);
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}/` : parent;
}

/**
 * Pick a file with the same tree the sidebar uses: the directory is walked
 * once, folders expand in place and the same language icons and muted
 * git-ignored files appear. The picker stays inside its starting directory;
 * the session's Open File dialog is for files the session works with.
 */
export function FilePicker({ onSelect, onCancel, startPath }: FilePickerProps) {
  const [currentPath, setCurrentPath] = useState(startPath);
  const [listing, setListing] = useState<SessionPathListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestRef = useRef(0);

  const load = useCallback(async (root: string) => {
    const request = ++requestRef.current;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/filesystem/tree?cwd=${encodeURIComponent(root)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({ error: "Failed to browse" }))) as { error?: string };
        throw new Error(body.error || "Failed to browse");
      }
      const data = (await res.json()) as SessionPathListing;
      if (request !== requestRef.current) return;
      setListing(data);
    } catch (err) {
      if (request !== requestRef.current) return;
      setListing(null);
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(currentPath);
  }, [currentPath, load]);

  const ignoredStatuses = useMemo(() => (listing?.ignored ?? []).map((path) => ({ path, status: "ignored" as const })), [listing]);

  const atStart = currentPath === startPath;

  return (
    <div className="space-y-3">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <button
          type="button"
          disabled={atStart}
          onClick={() => setCurrentPath(parentPath(currentPath))}
          title="Parent folder"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <CornerLeftUp className="h-3.5 w-3.5" />
        </button>
        <span className="truncate font-mono text-muted-foreground">{currentPath}</span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="px-3 py-4 text-sm text-destructive">{error}</div>
      ) : !listing || listing.paths.length === 0 ? (
        <div className="px-3 py-4 text-sm text-muted-foreground">Empty directory</div>
      ) : (
        <>
          <SessionFileTree
            key={currentPath}
            mode="picker"
            testId="file-picker-tree"
            height="min(60vh, 24rem)"
            paths={listing.paths}
            gitStatus={ignoredStatuses}
            onOpen={(relativePath) => onSelect(absolutePath(currentPath, relativePath))}
          />
          {listing.truncated && (
            <p className="text-[10px] text-muted-foreground">Showing the first {listing.paths.length.toLocaleString()} files.</p>
          )}
        </>
      )}

      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
