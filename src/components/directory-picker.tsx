"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Folder, ChevronRight, FolderPlus } from "lucide-react";

interface DirEntry {
  name: string;
  path: string;
}

interface DirectoryPickerProps {
  onSelect: (path: string) => void;
  onCancel: () => void;
}

export function DirectoryPicker({ onSelect, onCancel }: DirectoryPickerProps) {
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [createError, setCreateError] = useState("");

  const fetchEntries = useCallback(async (dirPath?: string) => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
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
    fetchEntries();
  }, [fetchEntries]);

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setCreateError("");

    try {
      const res = await fetch("/api/filesystem/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentPath: currentPath, name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed to create folder" }));
        setCreateError(body.error || "Failed to create folder");
        return;
      }
      const data = await res.json();
      setCreatingFolder(false);
      setNewFolderName("");
      fetchEntries(data.path);
    } catch {
      setCreateError("Failed to connect");
    }
  };

  const segments = currentPath.split("/").filter(Boolean);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 text-xs font-mono overflow-x-auto">
        <button
          type="button"
          onClick={() => fetchEntries("/")}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          /
        </button>
        {segments.map((seg, i) => {
          const segPath = "/" + segments.slice(0, i + 1).join("/");
          const isLast = i === segments.length - 1;
          return (
            <span key={segPath} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
              {isLast ? (
                <span className="text-foreground font-medium">{seg}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => fetchEntries(segPath)}
                  className="text-muted-foreground hover:text-foreground"
                >
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
        {error && (
          <div className="px-3 py-4 text-sm text-destructive">{error}</div>
        )}
        {!loading && !error && entries.length === 0 && !creatingFolder && (
          <div className="px-3 py-4 text-sm text-muted-foreground">No subdirectories</div>
        )}
        {!loading && !error && entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            onClick={() => fetchEntries(entry.path)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50 text-left"
          >
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{entry.name}</span>
          </button>
        ))}
        {creatingFolder && (
          <div className="px-3 py-1.5 space-y-1">
            <div className="flex items-center gap-2">
              <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Input
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); handleCreateFolder(); }
                  if (e.key === "Escape") { setCreatingFolder(false); setNewFolderName(""); setCreateError(""); }
                }}
                placeholder="Folder name"
                className="h-7 text-sm"
                autoFocus
              />
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={handleCreateFolder}>
                Create
              </Button>
            </div>
            {createError && <p className="text-xs text-destructive pl-6">{createError}</p>}
          </div>
        )}
      </div>

      <div className="flex gap-2 justify-end">
        {!creatingFolder && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => { setCreatingFolder(true); setCreateError(""); }}
            disabled={!currentPath}
          >
            <FolderPlus className="h-3.5 w-3.5 mr-1.5" />
            New Folder
          </Button>
        )}
        <div className="flex-1" />
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!currentPath}
          onClick={() => onSelect(currentPath)}
        >
          Select {currentPath ? currentPath.split("/").pop() || "/" : ""}
        </Button>
      </div>
    </div>
  );
}
