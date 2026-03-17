"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { useSettings } from "@/hooks/use-settings";
import { useShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  GitBranch,
  FilePlus,
  FileMinus,
  FileEdit,
  FileQuestion,
  FileSymlink,
  Trash2,
  Send,
  Check,
  ChevronUp,
  ChevronDown,
  Sparkles,
  ArrowUpFromLine,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface GitFileChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

interface GitStatus {
  branch: string;
  files: GitFileChange[];
  ahead: number;
}

function statusIcon(status: string) {
  switch (status) {
    case "added": return <FilePlus className="h-3.5 w-3.5 text-green-500 shrink-0" />;
    case "deleted": return <FileMinus className="h-3.5 w-3.5 text-red-500 shrink-0" />;
    case "renamed": return <FileSymlink className="h-3.5 w-3.5 text-blue-500 shrink-0" />;
    case "untracked": return <FileQuestion className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
    default: return <FileEdit className="h-3.5 w-3.5 text-yellow-500 shrink-0" />;
  }
}

function statusLabel(status: string) {
  switch (status) {
    case "added": return "A";
    case "deleted": return "D";
    case "renamed": return "R";
    case "untracked": return "?";
    default: return "M";
  }
}

function isDark(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

interface FileListProps {
  files: GitFileChange[];
  selectedFile: string | null;
  checkedFiles: Set<string>;
  onFileClick: (file: GitFileChange) => void;
  onContextMenu: (e: React.MouseEvent, file: GitFileChange) => void;
  onToggleFile: (path: string) => void;
  onToggleAll: () => void;
}

function FileList({ files, selectedFile, checkedFiles, onFileClick, onContextMenu, onToggleFile, onToggleAll }: FileListProps) {
  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        Working tree clean
      </div>
    );
  }

  return (
    <>
      <div className="px-3 py-1.5 border-b flex items-center gap-2">
        <input
          type="checkbox"
          checked={checkedFiles.size === files.length}
          onChange={onToggleAll}
          className="rounded"
        />
        <span className="text-xs text-muted-foreground">Select all</span>
      </div>
      {files.map((file) => (
        <div
          key={file.path}
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer border-b last:border-b-0 hover:bg-muted/50",
            selectedFile === file.path && "bg-muted"
          )}
          onClick={() => onFileClick(file)}
          onContextMenu={(e) => onContextMenu(e, file)}
        >
          <input
            type="checkbox"
            checked={checkedFiles.has(file.path)}
            onChange={(e) => {
              e.stopPropagation();
              onToggleFile(file.path);
            }}
            onClick={(e) => e.stopPropagation()}
            className="rounded"
          />
          {statusIcon(file.status)}
          <span className="font-mono text-xs truncate flex-1 min-w-0">
            {file.path}
          </span>
          <span className={cn(
            "text-xs font-mono shrink-0",
            file.status === "added" || file.status === "untracked" ? "text-green-500" :
            file.status === "deleted" ? "text-red-500" : "text-yellow-500"
          )}>
            {statusLabel(file.status)}
          </span>
        </div>
      ))}
    </>
  );
}

export function ChangesView({ cwd }: { cwd: string }) {
  const { settings } = useSettings();
  const { setSidebarContent, closeSidebar } = useShell();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: GitFileChange } | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());
  const [pushOnCommit, setPushOnCommit] = useState(false);
  const [commitPanelOpen, setCommitPanelOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<{ ok: boolean; message: string } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const fetchStatus = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed");
        return res.json();
      })
      .then((data: GitStatus) => {
        setStatus(data);
      })
      .catch(() => setError("Not a git repository"))
      .finally(() => setLoading(false));
  }, [cwd]);



  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const fetchDiff = useCallback((file: string) => {
    setDiffLoading(true);
    setDiff(null);
    fetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed");
        return res.json();
      })
      .then((data) => setDiff(data.diff))
      .catch(() => setDiff(null))
      .finally(() => setDiffLoading(false));
  }, [cwd]);

  const handleFileClick = useCallback((file: GitFileChange) => {
    setSelectedFile(file.path);
    fetchDiff(file.path);
    setContextMenu(null);
    closeSidebar();
  }, [fetchDiff, closeSidebar]);

  const handleContextMenu = useCallback((e: React.MouseEvent, file: GitFileChange) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, file });
  }, []);

  const handleDiscard = useCallback(async (file: GitFileChange) => {
    setContextMenu(null);
    try {
      const res = await fetch("/api/git/discard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, file: file.path, status: file.status }),
      });
      if (!res.ok) throw new Error("Failed");
      // Refresh and clear selection if discarded file was selected
      if (selectedFile === file.path) {
        setSelectedFile(null);
        setDiff(null);
      }
      fetchStatus();
    } catch {
      // Could show error toast
    }
  }, [cwd, selectedFile, fetchStatus]);

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim() || checkedFiles.size === 0) return;
    setCommitting(true);
    setCommitResult(null);
    try {
      const res = await fetch("/api/git/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          message: commitMsg.trim(),
          files: Array.from(checkedFiles),
          push: pushOnCommit,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to commit");
      }
      setCommitResult({ ok: true, message: pushOnCommit ? "Committed and pushed" : "Committed" });
      setCommitMsg("");
      setSelectedFile(null);
      setDiff(null);
      fetchStatus();
    } catch (err) {
      setCommitResult({ ok: false, message: err instanceof Error ? err.message : "Failed" });
    } finally {
      setCommitting(false);
    }
  }, [cwd, commitMsg, checkedFiles, pushOnCommit, fetchStatus]);

  const handleGenerate = useCallback(async () => {
    if (checkedFiles.size === 0) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/git/generate-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, files: Array.from(checkedFiles) }),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      if (data.message) setCommitMsg(data.message);
    } catch {
      // Could show error
    } finally {
      setGenerating(false);
    }
  }, [cwd, checkedFiles]);

  const handlePush = useCallback(async () => {
    setPushing(true);
    setPushResult(null);
    try {
      const res = await fetch("/api/git/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to push");
      }
      setPushResult({ ok: true, message: "Pushed" });
      fetchStatus();
    } catch (err) {
      setPushResult({ ok: false, message: err instanceof Error ? err.message : "Failed" });
    } finally {
      setPushing(false);
    }
  }, [cwd, fetchStatus]);

  const toggleFile = useCallback((path: string) => {
    setCheckedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (!status) return;
    const allPaths = status.files.map((f) => f.path);
    setCheckedFiles((prev) =>
      prev.size === allPaths.length ? new Set() : new Set(allPaths)
    );
  }, [status]);

  // Push file list into sidebar
  useEffect(() => {
    if (!status || status.files.length === 0) {
      setSidebarContent(null);
      return;
    }
    setSidebarContent(
      <FileList
        files={status.files}
        selectedFile={selectedFile}
        checkedFiles={checkedFiles}
        onFileClick={handleFileClick}
        onContextMenu={handleContextMenu}
        onToggleFile={toggleFile}
        onToggleAll={toggleAll}
      />
    );
    return () => setSidebarContent(null);
  }, [status, selectedFile, checkedFiles, handleFileClick, handleContextMenu, toggleFile, toggleAll, setSidebarContent]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [contextMenu]);

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center flex-1">
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    );
  }

  if (!status) return null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="shrink-0 border-b px-4 py-2 flex items-center gap-3">
        <GitBranch className="h-4 w-4 text-muted-foreground" />
        <span className="font-mono text-sm font-bold">{status.branch}</span>
        <span className="text-xs text-muted-foreground">
          {status.files.length} file{status.files.length !== 1 ? "s" : ""} changed
        </span>
        {status.ahead > 0 && (
          <span className="text-xs text-muted-foreground">
            {status.ahead} unpushed
          </span>
        )}
        {pushResult && (
          <span className={cn(
            "text-xs flex items-center gap-1",
            pushResult.ok ? "text-green-500" : "text-red-500"
          )}>
            {pushResult.ok && <Check className="h-3 w-3" />}
            {pushResult.message}
          </span>
        )}
        <div className="flex-1" />
        {status.ahead > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={handlePush}
            disabled={pushing}
            className="gap-1.5"
          >
            {pushing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUpFromLine className="h-3.5 w-3.5" />
            )}
            Push
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={fetchStatus}>
          Refresh
        </Button>
      </div>

      {/* Main content */}
      <div className="flex-1 min-h-0 flex flex-row">
        {/* Diff viewer */}
        <div className="flex-1 min-w-0 overflow-auto">
          {diffLoading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : selectedFile && diff ? (
            <div className="p-4">
              <div className="rounded border overflow-hidden">
                <PatchDiff
                  patch={diff}
                  options={{
                    theme: { dark: "pierre-dark", light: "pierre-light" },
                    themeType: isDark() ? "dark" : "light",
                    overflow: "wrap",
                    diffStyle: settings.diffStyle,
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground text-center px-4">
              {status.files.length > 0
                ? "Select a file from the sidebar to view changes"
                : "No changes"}
            </div>
          )}
        </div>
      </div>

      {/* Commit panel */}
      {status.files.length > 0 && (
        <div className="shrink-0 border-t">
          <button
            onClick={() => setCommitPanelOpen(!commitPanelOpen)}
            className="w-full px-4 py-2 flex items-center gap-2 text-sm font-medium hover:bg-muted/50"
          >
            {commitPanelOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
            Commit ({checkedFiles.size} file{checkedFiles.size !== 1 ? "s" : ""})
          </button>
          {commitPanelOpen && (
            <div className="px-4 pb-3 space-y-2">
              <textarea
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                placeholder="Commit message..."
                className="w-full rounded border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                rows={3}
              />
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleGenerate}
                  disabled={generating || checkedFiles.size === 0}
                  className="gap-1.5"
                >
                  {generating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {generating ? "Generating..." : "Generate"}
                </Button>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pushOnCommit}
                    onChange={(e) => setPushOnCommit(e.target.checked)}
                    className="rounded"
                  />
                  Push after commit
                </label>
                <div className="flex-1" />
                {commitResult && (
                  <span className={cn(
                    "text-xs flex items-center gap-1",
                    commitResult.ok ? "text-green-500" : "text-red-500"
                  )}>
                    {commitResult.ok && <Check className="h-3 w-3" />}
                    {commitResult.message}
                  </span>
                )}
                <Button
                  size="sm"
                  onClick={handleCommit}
                  disabled={committing || !commitMsg.trim() || checkedFiles.size === 0}
                  className="gap-1.5"
                >
                  {committing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  {pushOnCommit ? "Commit & Push" : "Commit"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 rounded border bg-background shadow-lg py-1 min-w-[140px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => handleDiscard(contextMenu.file)}
            className="w-full px-3 py-1.5 text-sm text-left hover:bg-muted flex items-center gap-2 text-red-500"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Discard changes
          </button>
        </div>
      )}
    </div>
  );
}
