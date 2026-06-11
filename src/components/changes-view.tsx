"use client";

import type { FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import {
  ArrowUpFromLine,
  Check,
  Check as CheckIcon,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileEdit,
  FileMinus,
  FilePlus,
  FileSymlink,
  GitBranch,
  Layers,
  List,
  Loader2,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShell } from "@/components/app-shell";
import { ChatView } from "@/components/chat-view";
import { DIFF_SELECTABLE_CSS, DiffErrorBoundary } from "@/components/diff-viewer";
import { ResizeHandle } from "@/components/resize-handle";
import { Button } from "@/components/ui/button";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { useSettings } from "@/hooks/use-settings";
import { useWebSocket } from "@/hooks/use-websocket";
import { useCheckedFiles } from "@/lib/checked-files";
import { cn } from "@/lib/utils";

function Checkbox({ checked, onChange, onClick }: { checked: boolean; onChange: () => void; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={(e) => {
        onClick?.(e);
        onChange();
      }}
      className={cn(
        "h-4 w-4 shrink-0 rounded border flex items-center justify-center transition-colors",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-muted-foreground/40 bg-transparent hover:border-muted-foreground/60",
      )}
    >
      {checked && <CheckIcon className="h-3 w-3" strokeWidth={3} />}
    </button>
  );
}

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
    case "added":
      return <FilePlus className="h-3.5 w-3.5 text-green-500 shrink-0" />;
    case "deleted":
      return <FileMinus className="h-3.5 w-3.5 text-red-500 shrink-0" />;
    case "renamed":
      return <FileSymlink className="h-3.5 w-3.5 text-blue-500 shrink-0" />;
    case "untracked":
      return <FilePlus className="h-3.5 w-3.5 text-green-500 shrink-0" />;
    default:
      return <FileEdit className="h-3.5 w-3.5 text-yellow-500 shrink-0" />;
  }
}

function statusLabel(status: string) {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "?";
    default:
      return "M";
  }
}

function isDark(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

function reindexForFullContent(meta: FileDiffMetadata, oldContent: string, newContent: string) {
  const oldLines = oldContent.split(/\r?\n/).map((l) => l + "\n");
  const newLines = newContent.split(/\r?\n/).map((l) => l + "\n");
  for (const hunk of meta.hunks) {
    const delDelta = hunk.deletionStart - 1 - hunk.deletionLineIndex;
    const addDelta = hunk.additionStart - 1 - hunk.additionLineIndex;
    hunk.deletionLineIndex = hunk.deletionStart - 1;
    hunk.additionLineIndex = hunk.additionStart - 1;
    for (const content of hunk.hunkContent) {
      content.deletionLineIndex += delDelta;
      content.additionLineIndex += addDelta;
    }
  }
  meta.deletionLines = oldLines;
  meta.additionLines = newLines;
  meta.isPartial = false;
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
    return <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">Working tree clean</div>;
  }

  return (
    <>
      <div className="px-3 py-1.5 border-b flex items-center gap-2">
        <Checkbox checked={checkedFiles.size === files.length} onChange={onToggleAll} />
        <span className="text-xs text-muted-foreground">Select all</span>
      </div>
      {files.map((file) => (
        <div
          key={file.path}
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer border-b last:border-b-0 hover:bg-muted/50",
            selectedFile === file.path && "bg-muted",
          )}
          onClick={() => onFileClick(file)}
          onContextMenu={(e) => onContextMenu(e, file)}
        >
          <Checkbox checked={checkedFiles.has(file.path)} onChange={() => onToggleFile(file.path)} onClick={(e) => e.stopPropagation()} />
          {statusIcon(file.status)}
          <span className="font-mono text-xs truncate flex-1 min-w-0 text-left" dir="rtl" title={file.path}>
            <bdo dir="ltr">{file.path}</bdo>
          </span>
          {(file.additions > 0 || file.deletions > 0) && (
            <span className="text-xs font-mono shrink-0 flex items-center gap-1">
              {file.additions > 0 && <span className="text-green-500">+{file.additions}</span>}
              {file.deletions > 0 && <span className="text-red-500">-{file.deletions}</span>}
            </span>
          )}
          <span
            className={cn(
              "text-xs font-mono shrink-0",
              file.status === "added" || file.status === "untracked"
                ? "text-green-500"
                : file.status === "deleted"
                  ? "text-red-500"
                  : "text-yellow-500",
            )}
          >
            {statusLabel(file.status)}
          </span>
        </div>
      ))}
    </>
  );
}

// --- Stacked Diffs ---

interface FileDiffState {
  diff: string | null;
  fileDiff: FileDiffMetadata | null;
  loading: boolean;
}

interface StackedDiffsProps {
  files: GitFileChange[];
  cwd: string;
  diffStyle: "split" | "unified";
  scrollToFile: string | null;
  onScrolled: () => void;
  onViewFile: (filePath: string) => void;
  checkedFiles: Set<string>;
  onToggleFile: (path: string) => void;
  refreshKey: number;
}

function StackedDiffs({
  files,
  cwd,
  diffStyle,
  scrollToFile,
  onScrolled,
  onViewFile,
  checkedFiles,
  onToggleFile,
  refreshKey,
}: StackedDiffsProps) {
  const [diffs, setDiffs] = useState<Map<string, FileDiffState>>(new Map());
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const fetchedRef = useRef<Set<string>>(new Set());
  const lastRefreshKey = useRef(refreshKey);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  const fetchDiff = useCallback(
    (file: string) => {
      setDiffs((prev) => {
        const next = new Map(prev);
        next.set(file, { diff: prev.get(file)?.diff || null, fileDiff: prev.get(file)?.fileDiff || null, loading: true });
        return next;
      });
      fetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`)
        .then((res) => {
          if (!res.ok) throw new Error("Failed");
          return res.json();
        })
        .then((data: { diff: string; oldContent?: string; newContent?: string }) => {
          let fileDiffMeta: FileDiffMetadata | null = null;
          try {
            const parsed = parsePatchFiles(data.diff);
            if (parsed.length > 0 && parsed[0].files.length > 0) {
              fileDiffMeta = parsed[0].files[0];
              if (data.oldContent != null && data.newContent != null) {
                reindexForFullContent(fileDiffMeta, data.oldContent, data.newContent);
              }
            }
          } catch {
            // Fall back to raw diff string
          }
          setDiffs((prev) => {
            const next = new Map(prev);
            next.set(file, { diff: data.diff, fileDiff: fileDiffMeta, loading: false });
            return next;
          });
        })
        .catch(() => {
          setDiffs((prev) => {
            const next = new Map(prev);
            next.set(file, { diff: null, fileDiff: null, loading: false });
            return next;
          });
        });
    },
    [cwd],
  );

  // Fetch all diffs on mount, when files change, or when refreshKey bumps
  useEffect(() => {
    const forceRefresh = refreshKey !== lastRefreshKey.current;
    lastRefreshKey.current = refreshKey;
    if (forceRefresh) fetchedRef.current.clear();

    const currentPaths = new Set(files.map((f) => f.path));
    const toFetch = files.filter((f) => !fetchedRef.current.has(f.path));
    for (const f of toFetch) {
      fetchedRef.current.add(f.path);
      fetchDiff(f.path);
    }
    for (const path of fetchedRef.current) {
      if (!currentPaths.has(path)) fetchedRef.current.delete(path);
    }
  }, [files, fetchDiff, refreshKey]);

  // Scroll to file when requested
  useEffect(() => {
    if (!scrollToFile) return;
    const el = sectionRefs.current.get(scrollToFile);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    onScrolled();
  }, [scrollToFile, onScrolled]);

  const toggleCollapse = useCallback((path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleToggleChecked = useCallback(
    (path: string) => {
      onToggleFile(path);
      if (!checkedFiles.has(path)) {
        setCollapsedFiles((prev) => new Set(prev).add(path));
      }
    },
    [onToggleFile, checkedFiles],
  );

  if (files.length === 0) {
    return <div className="flex items-center justify-center h-full text-sm text-muted-foreground">No changes</div>;
  }

  return (
    <div className="p-4 space-y-3">
      {files.map((file) => {
        const state = diffs.get(file.path);
        const checked = checkedFiles.has(file.path);
        const collapsed = collapsedFiles.has(file.path);

        return (
          <div
            key={file.path}
            ref={(el) => {
              if (el) sectionRefs.current.set(file.path, el);
            }}
            className={cn("rounded border overflow-clip", checked && !collapsed && "opacity-60")}
          >
            {collapsed ? (
              <div className="flex items-center gap-2 w-full px-4 py-2 text-sm text-muted-foreground">
                <Checkbox
                  checked={checked}
                  onChange={() => {
                    onToggleFile(file.path);
                    if (checked)
                      setCollapsedFiles((prev) => {
                        const next = new Set(prev);
                        next.delete(file.path);
                        return next;
                      });
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
                <button
                  onClick={() => toggleCollapse(file.path)}
                  className="flex items-center gap-2 flex-1 min-w-0 hover:text-foreground transition-colors"
                >
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                  <span className="font-mono text-xs truncate text-left" dir="rtl" title={file.path}>
                    <bdo dir="ltr">{file.path}</bdo>
                  </span>
                </button>
              </div>
            ) : state?.loading && !state.diff ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : state?.diff ? (
              <>
                <div
                  className="sticky top-0 z-10 flex items-center gap-2 px-4 py-1.5 text-sm border-b bg-muted/80 backdrop-blur-sm"
                  data-testid="sticky-diff-header"
                >
                  {statusIcon(file.status)}
                  <span className="font-mono text-xs truncate flex-1 min-w-0 text-left" dir="rtl" title={file.path}>
                    <bdo dir="ltr">{file.path}</bdo>
                  </span>
                  <Checkbox checked={checked} onChange={() => handleToggleChecked(file.path)} onClick={(e) => e.stopPropagation()} />
                  <button
                    onClick={() => toggleCollapse(file.path)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    title="Collapse"
                  >
                    <ChevronUp className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => onViewFile(file.path)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </button>
                </div>
                <DiffErrorBoundary fallback={<pre className="p-4 text-xs text-muted-foreground whitespace-pre-wrap">{state.diff}</pre>}>
                  {state.fileDiff ? (
                    <FileDiff
                      fileDiff={state.fileDiff}
                      options={{
                        theme: { dark: "pierre-dark", light: "pierre-light" },
                        themeType: isDark() ? "dark" : "light",
                        overflow: "wrap",
                        diffStyle,
                        disableFileHeader: true,
                        hunkSeparators: "line-info",
                        expansionLineCount: 20,
                        unsafeCSS: DIFF_SELECTABLE_CSS,
                      }}
                    />
                  ) : (
                    <pre className="p-4 text-xs text-muted-foreground whitespace-pre-wrap">{state.diff}</pre>
                  )}
                </DiffErrorBoundary>
              </>
            ) : (
              <div className="px-4 py-3 text-xs text-muted-foreground">No diff available</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- State Cache ---

interface ChangesState {
  selectedFile: string | null;
  commitMsg: string;
  commitPanelOpen: boolean;
  pushOnCommit: boolean;
  stackedMode: boolean;
  chatRatio: number;
}

const stateCache = new Map<string, ChangesState>();
const DEFAULT_CHAT_RATIO = 0.3;
const MIN_CHAT_RATIO = 0.15;
const MAX_CHAT_RATIO = 0.5;

function isDesktopStatic(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(min-width: 768px)").matches;
}

function getCachedState(cwd: string): ChangesState {
  return (
    stateCache.get(cwd) || {
      selectedFile: null,
      commitMsg: "",
      commitPanelOpen: isDesktopStatic(),
      pushOnCommit: false,
      stackedMode: true,
      chatRatio: DEFAULT_CHAT_RATIO,
    }
  );
}

// --- Main Component ---

export function ChangesView({
  cwd,
  sessionId,
  embeddedChat = true,
  manageSidebar = true,
}: {
  cwd: string;
  sessionId?: string | null;
  embeddedChat?: boolean;
  manageSidebar?: boolean;
}) {
  const { settings } = useSettings();
  const { setSidebarSection, removeSidebarSection, closeSidebar, tabActions } = useShell();
  const { send, subscribe } = useWebSocket();
  const isDesktop = useIsDesktop();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cached = getCachedState(cwd);
  const [selectedFile, setSelectedFile] = useState<string | null>(cached.selectedFile);
  const [diff, setDiff] = useState<string | null>(null);
  const [singleFileDiff, setSingleFileDiff] = useState<FileDiffMetadata | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: GitFileChange } | null>(null);
  const [commitMsg, setCommitMsg] = useState(cached.commitMsg);
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<{ ok: boolean; message: string } | null>(null);
  const { checkedFiles, toggleFile, toggleAll: sharedToggleAll, setCheckedFiles } = useCheckedFiles(cwd);
  const [pushOnCommit, setPushOnCommit] = useState(cached.pushOnCommit);
  const [commitPanelOpen, setCommitPanelOpen] = useState(cached.commitPanelOpen);
  const [generating, setGenerating] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [stackedMode, setStackedMode] = useState(cached.stackedMode);
  const [chatRatio, setChatRatio] = useState(cached.chatRatio);
  const [scrollToFile, setScrollToFile] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Persist state changes to cache
  useEffect(() => {
    stateCache.set(cwd, { selectedFile, commitMsg, commitPanelOpen, pushOnCommit, stackedMode, chatRatio });
  }, [cwd, selectedFile, commitMsg, commitPanelOpen, pushOnCommit, stackedMode, chatRatio]);

  const fetchStatus = useCallback(
    (opts?: { gitFetch?: boolean; refresh?: boolean }) => {
      if (!opts?.refresh) setLoading(true);
      setError(null);
      const params = new URLSearchParams({ cwd });
      if (opts?.gitFetch) params.set("fetch", "1");
      fetch(`/api/git/status?${params}`)
        .then((res) => {
          if (!res.ok) throw new Error("Failed");
          return res.json();
        })
        .then((data: GitStatus) => {
          setStatus(data);
          if (opts?.refresh) setRefreshKey((k) => k + 1);
        })
        .catch(() => setError("Not a git repository"))
        .finally(() => setLoading(false));
    },
    [cwd],
  );

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    send({ type: "watch:cwd", cwd });
  }, [send, cwd]);

  // Auto-refresh when the chat session finishes a turn
  const prevStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const unsub = subscribe((msg) => {
      if (msg.type !== "session:status" || !("sessionId" in msg) || msg.sessionId !== sessionId) return;
      const prev = prevStatusRef.current;
      prevStatusRef.current = msg.status;
      if (prev === "running" && msg.status === "idle") {
        fetchStatus({ refresh: true });
      }
    });
    return unsub;
  }, [sessionId, subscribe, fetchStatus]);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== "session:fs_changed") return;
      fetchStatus({ refresh: true });
    });
  }, [subscribe, fetchStatus]);

  const fetchDiff = useCallback(
    (file: string) => {
      setDiffLoading(true);
      setDiff(null);
      setSingleFileDiff(null);
      fetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`)
        .then((res) => {
          if (!res.ok) throw new Error("Failed");
          return res.json();
        })
        .then((data: { diff: string; oldContent?: string; newContent?: string }) => {
          setDiff(data.diff);
          try {
            const parsed = parsePatchFiles(data.diff);
            if (parsed.length > 0 && parsed[0].files.length > 0) {
              const meta = parsed[0].files[0];
              if (data.oldContent != null && data.newContent != null) {
                reindexForFullContent(meta, data.oldContent, data.newContent);
              }
              setSingleFileDiff(meta);
            }
          } catch {
            // Fall back to raw diff
          }
        })
        .catch(() => setDiff(null))
        .finally(() => setDiffLoading(false));
    },
    [cwd],
  );

  // Re-fetch diff for selected file (single-file mode) on mount or refresh
  const lastRefreshRef = useRef(refreshKey);
  useEffect(() => {
    if (!selectedFile || stackedMode) return;
    const isRefresh = lastRefreshRef.current !== refreshKey;
    lastRefreshRef.current = refreshKey;
    if (isRefresh) {
      // Background refresh: keep old diff visible, just re-fetch
      fetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(selectedFile)}`)
        .then((res) => {
          if (!res.ok) throw new Error("Failed");
          return res.json();
        })
        .then((data: { diff: string; oldContent?: string; newContent?: string }) => {
          setDiff(data.diff);
          try {
            const parsed = parsePatchFiles(data.diff);
            if (parsed.length > 0 && parsed[0].files.length > 0) {
              const meta = parsed[0].files[0];
              if (data.oldContent != null && data.newContent != null) {
                reindexForFullContent(meta, data.oldContent, data.newContent);
              }
              setSingleFileDiff(meta);
            }
          } catch {
            // Fall back to raw diff
          }
        })
        .catch(() => {});
    } else {
      fetchDiff(selectedFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackedMode, selectedFile, fetchDiff, refreshKey, cwd]);

  // Auto-select first file when status loads and nothing is selected
  useEffect(() => {
    if (!status || status.files.length === 0) return;
    if (selectedFile) return;
    if (stackedMode) return;
    const first = status.files[0];
    setSelectedFile(first.path);
    fetchDiff(first.path);
  }, [status, selectedFile, stackedMode, fetchDiff]);

  const handleFileClick = useCallback(
    (file: GitFileChange) => {
      if (stackedMode) {
        setScrollToFile(file.path);
      } else {
        setSelectedFile(file.path);
        fetchDiff(file.path);
        setContextMenu(null);
        closeSidebar();
      }
    },
    [stackedMode, fetchDiff, closeSidebar],
  );

  const handleContextMenu = useCallback((e: React.MouseEvent, file: GitFileChange) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, file });
  }, []);

  const handleDiscard = useCallback(
    async (file: GitFileChange) => {
      setContextMenu(null);
      try {
        const res = await fetch("/api/git/discard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, file: file.path, status: file.status }),
        });
        if (!res.ok) throw new Error("Failed");
        if (selectedFile === file.path) {
          setSelectedFile(null);
          setDiff(null);
        }
        fetchStatus();
      } catch {
        // Could show error toast
      }
    },
    [cwd, selectedFile, fetchStatus],
  );

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
      setCheckedFiles(new Set());
      setSelectedFile(null);
      setDiff(null);
      fetchStatus();
    } catch (err) {
      setCommitResult({ ok: false, message: err instanceof Error ? err.message : "Failed" });
    } finally {
      setCommitting(false);
    }
  }, [cwd, commitMsg, checkedFiles, pushOnCommit, fetchStatus, setCheckedFiles]);

  const handleGenerate = useCallback(async () => {
    if (checkedFiles.size === 0) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/git/generate-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, files: Array.from(checkedFiles) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      if (data.message) setCommitMsg(data.message);
    } catch (err) {
      console.error("[generate-message]", err);
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

  const toggleAll = useCallback(() => {
    if (!status) return;
    sharedToggleAll(status.files.map((f) => f.path));
  }, [status, sharedToggleAll]);

  const handleResize = useCallback((delta: number) => {
    const width = window.innerWidth || 1;
    setChatRatio((r) => Math.max(MIN_CHAT_RATIO, Math.min(MAX_CHAT_RATIO, r + delta / width)));
  }, []);

  const handleScrolled = useCallback(() => {
    setScrollToFile(null);
  }, []);

  const handleViewFile = useCallback(
    (filePath: string) => {
      const fullPath = filePath.startsWith("/") ? filePath : `${cwd}/${filePath}`;
      tabActions?.openFile(fullPath);
    },
    [cwd, tabActions],
  );

  useEffect(() => {
    if (!manageSidebar) return;
    if (!status || status.files.length === 0) {
      removeSidebarSection("git-changes");
      return;
    }
    setSidebarSection({
      id: "git-changes",
      title: "Changes",
      order: 20,
      badge: String(status.files.length),
      content: (
        <FileList
          files={status.files}
          selectedFile={stackedMode ? null : selectedFile}
          checkedFiles={checkedFiles}
          onFileClick={handleFileClick}
          onContextMenu={handleContextMenu}
          onToggleFile={toggleFile}
          onToggleAll={toggleAll}
        />
      ),
    });
    return () => removeSidebarSection("git-changes");
  }, [
    manageSidebar,
    status,
    selectedFile,
    checkedFiles,
    stackedMode,
    handleFileClick,
    handleContextMenu,
    toggleFile,
    toggleAll,
    setSidebarSection,
    removeSidebarSection,
  ]);

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

  const showChat = embeddedChat && isDesktop && !!sessionId;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="shrink-0 border-b px-4 py-2 flex items-center gap-3">
        <GitBranch className="h-4 w-4 text-muted-foreground" />
        <span className="font-mono text-sm font-bold">{status.branch}</span>
        <span className="text-xs text-muted-foreground">
          {status.files.length} file{status.files.length !== 1 ? "s" : ""} changed
        </span>
        {(() => {
          const totalAdd = status.files.reduce((s, f) => s + f.additions, 0);
          const totalDel = status.files.reduce((s, f) => s + f.deletions, 0);
          return totalAdd > 0 || totalDel > 0 ? (
            <span className="text-xs font-mono flex items-center gap-1">
              {totalAdd > 0 && <span className="text-green-500">+{totalAdd}</span>}
              {totalDel > 0 && <span className="text-red-500">-{totalDel}</span>}
            </span>
          ) : null;
        })()}
        {status.ahead > 0 && <span className="text-xs text-muted-foreground">{status.ahead} unpushed</span>}
        {pushResult && (
          <span className={cn("text-xs flex items-center gap-1", pushResult.ok ? "text-green-500" : "text-red-500")}>
            {pushResult.ok && <Check className="h-3 w-3" />}
            {pushResult.message}
          </span>
        )}
        <div className="flex-1" />
        {/* Stacked/Single toggle */}
        {status.files.length > 0 && (
          <div className="flex items-center gap-0.5 rounded-md border p-0.5">
            <button
              onClick={() => setStackedMode(true)}
              className={cn(
                "rounded px-1.5 py-0.5 text-xs transition-colors",
                stackedMode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              title="Stacked view"
            >
              <Layers className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setStackedMode(false)}
              className={cn(
                "rounded px-1.5 py-0.5 text-xs transition-colors",
                !stackedMode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              title="Single file view"
            >
              <List className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {status.ahead > 0 && (
          <Button variant="outline" size="sm" onClick={handlePush} disabled={pushing} className="gap-1.5">
            {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpFromLine className="h-3.5 w-3.5" />}
            Push
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => fetchStatus({ gitFetch: true })}>
          Refresh
        </Button>
      </div>

      {/* Main content */}
      <div className="flex-1 min-h-0 flex flex-row">
        {/* Diff column */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto">
            {stackedMode ? (
              <StackedDiffs
                files={status.files}
                cwd={cwd}
                diffStyle={settings.diffStyle}
                scrollToFile={scrollToFile}
                onScrolled={handleScrolled}
                onViewFile={handleViewFile}
                checkedFiles={checkedFiles}
                onToggleFile={toggleFile}
                refreshKey={refreshKey}
              />
            ) : diffLoading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : selectedFile && diff ? (
              <div className="p-4">
                <div className="rounded-lg border overflow-hidden">
                  {(() => {
                    const file = status.files.find((f) => f.path === selectedFile);
                    return file ? (
                      <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-1.5 text-sm border-b bg-muted/80 backdrop-blur-sm">
                        {statusIcon(file.status)}
                        <span className="font-mono text-xs truncate flex-1 min-w-0 text-left" dir="rtl" title={file.path}>
                          <bdo dir="ltr">{file.path}</bdo>
                        </span>
                        <Checkbox
                          checked={checkedFiles.has(file.path)}
                          onChange={() => toggleFile(file.path)}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <button
                          onClick={() => handleViewFile(file.path)}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                          title="Open in editor"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </button>
                      </div>
                    ) : null;
                  })()}
                  <DiffErrorBoundary fallback={<pre className="p-4 text-xs text-muted-foreground whitespace-pre-wrap">{diff}</pre>}>
                    {singleFileDiff ? (
                      <FileDiff
                        fileDiff={singleFileDiff}
                        options={{
                          theme: { dark: "pierre-dark", light: "pierre-light" },
                          themeType: isDark() ? "dark" : "light",
                          overflow: "wrap",
                          diffStyle: settings.diffStyle,
                          disableFileHeader: true,
                          hunkSeparators: "line-info",
                          expansionLineCount: 20,
                          unsafeCSS: DIFF_SELECTABLE_CSS,
                        }}
                      />
                    ) : (
                      <pre className="p-4 text-xs text-muted-foreground whitespace-pre-wrap">{diff}</pre>
                    )}
                  </DiffErrorBoundary>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground text-center px-4">
                {status.files.length > 0 ? "Select a file from the sidebar to view changes" : "No changes"}
              </div>
            )}
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
                      {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                      {generating ? "Generating..." : "Generate"}
                    </Button>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                      <Checkbox checked={pushOnCommit} onChange={() => setPushOnCommit(!pushOnCommit)} />
                      Push after commit
                    </label>
                    <div className="flex-1" />
                    {commitResult && (
                      <span className={cn("text-xs flex items-center gap-1", commitResult.ok ? "text-green-500" : "text-red-500")}>
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
                      {committing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                      {pushOnCommit ? "Commit & Push" : "Commit"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Resize handle + Chat panel - desktop only */}
        {showChat && (
          <>
            <ResizeHandle onResize={handleResize} />
            <div className="flex flex-col shrink-0 border-l min-h-0" style={{ width: `${chatRatio * 100}%` }}>
              <ChatView sessionId={sessionId} cwd={cwd} />
            </div>
          </>
        )}
      </div>

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
