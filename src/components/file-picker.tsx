"use client";

import { ChevronRight, CornerLeftUp, File, Folder, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { splitPathSegments } from "@/lib/path";

interface BrowseEntry {
  name: string;
  path: string;
  type: "directory" | "file";
}

interface FilePickerProps {
  onSelect: (path: string) => void;
  onCancel: () => void;
  startPath?: string;
}

export function FilePicker({ onSelect, onCancel, startPath }: FilePickerProps) {
  const [currentPath, setCurrentPath] = useState(startPath ?? "");
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchEntries = useCallback(async (dirPath?: string) => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ includeFiles: "true" });
    if (dirPath) params.set("path", dirPath);

    try {
      const res = await fetch(`/api/filesystem/browse?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed to browse" }));
        setError(body.error || "Failed to browse");
        setEntries([]);
        return;
      }
      const data = await res.json();
      setCurrentPath(data.path);
      setEntries(data.entries);
    } catch {
      setError("Failed to connect");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEntries(startPath);
  }, [fetchEntries, startPath]);

  const hasDriveLetter = /^[a-zA-Z]:[/\\]/.test(currentPath);
  const rootLabel = hasDriveLetter ? currentPath.slice(0, 3) : "/";
  const rootPath = hasDriveLetter ? currentPath.slice(0, 3) : "/";
  const allSegments = splitPathSegments(currentPath);
  const segments = hasDriveLetter ? allSegments.slice(1) : allSegments;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 text-xs font-mono overflow-x-auto">
        <button type="button" onClick={() => fetchEntries(rootPath)} className="shrink-0 text-muted-foreground hover:text-foreground">
          {rootLabel}
        </button>
        {segments.map((seg, i) => {
          const segPath = rootPath + segments.slice(0, i + 1).join("/");
          const isLast = i === segments.length - 1;
          return (
            <span key={segPath} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
              {isLast ? (
                <span className="text-foreground font-medium">{seg}</span>
              ) : (
                <button type="button" onClick={() => fetchEntries(segPath)} className="text-muted-foreground hover:text-foreground">
                  {seg}
                </button>
              )}
            </span>
          );
        })}
      </div>

      <div className="border rounded-md max-h-56 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && <div className="px-3 py-4 text-sm text-destructive">{error}</div>}
        {!loading && !error && currentPath !== rootPath && (
          <button
            type="button"
            onClick={() => {
              const parent = currentPath.replace(/\/[^/]+\/?$/, "") || rootPath;
              fetchEntries(parent);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50 text-left text-muted-foreground"
          >
            <CornerLeftUp className="h-4 w-4 shrink-0" />
            <span>..</span>
          </button>
        )}
        {!loading && !error && entries.length === 0 && <div className="px-3 py-4 text-sm text-muted-foreground">Empty directory</div>}
        {!loading &&
          !error &&
          entries.map((entry) =>
            entry.type === "directory" ? (
              <button
                key={entry.path}
                type="button"
                onClick={() => fetchEntries(entry.path)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50 text-left"
              >
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
              </button>
            ) : (
              <button
                key={entry.path}
                type="button"
                onClick={() => onSelect(entry.path)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50 text-left"
              >
                <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
              </button>
            ),
          )}
      </div>

      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
