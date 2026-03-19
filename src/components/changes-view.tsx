"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { useSettings } from "@/hooks/use-settings";
import { DiffErrorBoundary } from "@/components/diff-viewer";
import { useShell } from "@/components/app-shell";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { ChatView } from "@/components/chat-view";
import { CodeBlock } from "@/components/code-block";
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
  ChevronRight,
  Sparkles,
  ArrowUpFromLine,
  Layers,
  List,
  Plus,
  Minus,
  Eye,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Check as CheckIcon } from "lucide-react";

function Checkbox({ checked, onChange, onClick }: { checked: boolean; onChange: () => void; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={(e) => { onClick?.(e); onChange(); }}
      className={cn(
        "h-4 w-4 shrink-0 rounded border flex items-center justify-center transition-colors",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-muted-foreground/40 bg-transparent hover:border-muted-foreground/60"
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

function languageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
    swift: "swift", kt: "kotlin", sh: "bash", bash: "bash",
    zsh: "bash", fish: "fish", ps1: "powershell",
    html: "html", css: "css", scss: "scss", less: "less",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    xml: "xml", sql: "sql", md: "markdown", mdx: "mdx",
    graphql: "graphql", gql: "graphql", dockerfile: "dockerfile",
    lua: "lua", r: "r", php: "php", pl: "perl", ex: "elixir",
    exs: "elixir", erl: "erlang", hs: "haskell", ml: "ocaml",
    vim: "vim", makefile: "makefile", cmake: "cmake",
  };
  return map[ext] || "text";
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
        <Checkbox checked={checkedFiles.size === files.length} onChange={onToggleAll} />
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
          <Checkbox
            checked={checkedFiles.has(file.path)}
            onChange={() => onToggleFile(file.path)}
            onClick={(e) => e.stopPropagation()}
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

// --- Stacked Diffs ---

interface FileDiffState {
  diff: string | null;
  loading: boolean;
  contextLines: number;
  collapsed: boolean;
  viewingFile: boolean;
  fileContent: string | null;
  fileLoading: boolean;
}

const CONTEXT_STEPS = [3, 10, 30, 100, 500];

interface StackedDiffsProps {
  files: GitFileChange[];
  cwd: string;
  diffStyle: "split" | "unified";
  scrollToFile: string | null;
  onScrolled: () => void;
}

function StackedDiffs({ files, cwd, diffStyle, scrollToFile, onScrolled }: StackedDiffsProps) {
  const [diffs, setDiffs] = useState<Map<string, FileDiffState>>(new Map());
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const fetchedRef = useRef<Set<string>>(new Set());

  const fetchDiff = useCallback((file: string, contextLines: number = 3) => {
    setDiffs((prev) => {
      const next = new Map(prev);
      const existing = next.get(file);
      next.set(file, { diff: existing?.diff || null, loading: true, contextLines, collapsed: existing?.collapsed || false, viewingFile: false, fileContent: null, fileLoading: false });
      return next;
    });
    const contextParam = contextLines !== 3 ? `&context=${contextLines}` : "";
    fetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}${contextParam}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed");
        return res.json();
      })
      .then((data) => {
        setDiffs((prev) => {
          const next = new Map(prev);
          const existing = next.get(file);
          next.set(file, { ...existing!, diff: data.diff, loading: false });
          return next;
        });
      })
      .catch(() => {
        setDiffs((prev) => {
          const next = new Map(prev);
          const existing = next.get(file);
          next.set(file, { ...existing!, diff: null, loading: false });
          return next;
        });
      });
  }, [cwd]);

  // Fetch all diffs on mount or when files change
  useEffect(() => {
    const currentPaths = new Set(files.map((f) => f.path));
    const toFetch = files.filter((f) => !fetchedRef.current.has(f.path));
    if (toFetch.length === 0) return;
    for (const f of toFetch) {
      fetchedRef.current.add(f.path);
      fetchDiff(f.path);
    }
    // Clean up removed files
    for (const path of fetchedRef.current) {
      if (!currentPaths.has(path)) {
        fetchedRef.current.delete(path);
      }
    }
  }, [files, fetchDiff]);

  // Scroll to file when requested
  useEffect(() => {
    if (!scrollToFile) return;
    const el = sectionRefs.current.get(scrollToFile);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      // Expand if collapsed
      setDiffs((prev) => {
        const next = new Map(prev);
        const existing = next.get(scrollToFile);
        if (existing?.collapsed) {
          next.set(scrollToFile, { ...existing, collapsed: false });
        }
        return next;
      });
    }
    onScrolled();
  }, [scrollToFile, onScrolled]);

  const toggleCollapse = useCallback((path: string) => {
    setDiffs((prev) => {
      const next = new Map(prev);
      const existing = next.get(path);
      if (existing) {
        next.set(path, { ...existing, collapsed: !existing.collapsed });
      }
      return next;
    });
  }, []);

  const expandContext = useCallback((path: string) => {
    setDiffs((prev) => {
      const existing = prev.get(path);
      if (!existing) return prev;
      const currentIdx = CONTEXT_STEPS.indexOf(existing.contextLines);
      const nextLines = CONTEXT_STEPS[Math.min(currentIdx + 1, CONTEXT_STEPS.length - 1)];
      if (nextLines === existing.contextLines) return prev;
      fetchDiff(path, nextLines);
      return prev;
    });
  }, [fetchDiff]);

  const shrinkContext = useCallback((path: string) => {
    setDiffs((prev) => {
      const existing = prev.get(path);
      if (!existing) return prev;
      const currentIdx = CONTEXT_STEPS.indexOf(existing.contextLines);
      const prevLines = CONTEXT_STEPS[Math.max(currentIdx - 1, 0)];
      if (prevLines === existing.contextLines) return prev;
      fetchDiff(path, prevLines);
      return prev;
    });
  }, [fetchDiff]);

  const viewFile = useCallback((path: string) => {
    setDiffs((prev) => {
      const next = new Map(prev);
      const existing = next.get(path);
      if (!existing) return prev;
      if (existing.viewingFile) {
        next.set(path, { ...existing, viewingFile: false });
        return next;
      }
      next.set(path, { ...existing, viewingFile: true, fileLoading: true });
      return next;
    });
    fetch(`/api/filesystem/read?path=${encodeURIComponent(cwd + "/" + path)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed");
        return res.json();
      })
      .then((data) => {
        setDiffs((prev) => {
          const next = new Map(prev);
          const existing = next.get(path);
          if (existing) {
            next.set(path, { ...existing, fileContent: data.binary ? "Binary file" : data.content, fileLoading: false });
          }
          return next;
        });
      })
      .catch(() => {
        setDiffs((prev) => {
          const next = new Map(prev);
          const existing = next.get(path);
          if (existing) {
            next.set(path, { ...existing, fileContent: null, fileLoading: false, viewingFile: false });
          }
          return next;
        });
      });
  }, [cwd]);

  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No changes
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      {files.map((file) => {
        const state = diffs.get(file.path);
        const collapsed = state?.collapsed || false;

        return (
          <div
            key={file.path}
            ref={(el) => { if (el) sectionRefs.current.set(file.path, el); }}
            className="rounded border overflow-hidden"
          >
            {/* File header */}
            <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/50 border-b text-sm sticky top-0 z-10">
              <button onClick={() => toggleCollapse(file.path)} className="shrink-0">
                {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              {statusIcon(file.status)}
              <span className="font-mono text-xs truncate flex-1 min-w-0">{file.path}</span>
              {file.additions > 0 && <span className="text-xs text-green-500">+{file.additions}</span>}
              {file.deletions > 0 && <span className="text-xs text-red-500">-{file.deletions}</span>}
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => shrinkContext(file.path)}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="Less context"
                >
                  <Minus className="h-3 w-3" />
                </button>
                <span className="text-[10px] text-muted-foreground w-4 text-center">{state?.contextLines || 3}</span>
                <button
                  onClick={() => expandContext(file.path)}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="More context"
                >
                  <Plus className="h-3 w-3" />
                </button>
                <button
                  onClick={() => viewFile(file.path)}
                  className={cn(
                    "rounded p-0.5 transition-colors ml-1",
                    state?.viewingFile
                      ? "text-primary bg-primary/10"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  )}
                  title={state?.viewingFile ? "Back to diff" : "View file"}
                >
                  {state?.viewingFile ? <X className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </button>
              </div>
            </div>
            {/* Content */}
            {!collapsed && (
              <div>
                {state?.viewingFile ? (
                  state.fileLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : state.fileContent !== null ? (
                    <CodeBlock code={state.fileContent} language={languageFromPath(file.path)} fullHeight />
                  ) : null
                ) : state?.loading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : state?.diff ? (
                  <DiffErrorBoundary fallback={<pre className="p-4 text-xs text-muted-foreground whitespace-pre-wrap">{state.diff}</pre>}>
                    <PatchDiff
                      patch={state.diff}
                      options={{
                        theme: { dark: "pierre-dark", light: "pierre-light" },
                        themeType: isDark() ? "dark" : "light",
                        overflow: "wrap",
                        diffStyle,
                      }}
                    />
                  </DiffErrorBoundary>
                ) : (
                  <div className="px-4 py-3 text-xs text-muted-foreground">No diff available</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- Resize Handle ---

function ResizeHandle({ onResize }: { onResize: (delta: number) => void }) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    lastX.current = e.clientX;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = lastX.current - ev.clientX;
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
  }, [onResize]);

  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/30 transition-colors"
    />
  );
}

// --- State Cache ---

interface ChangesState {
  selectedFile: string | null;
  checkedFiles: Set<string>;
  commitMsg: string;
  commitPanelOpen: boolean;
  pushOnCommit: boolean;
  stackedMode: boolean;
  chatWidth: number;
}

const stateCache = new Map<string, ChangesState>();
const DEFAULT_CHAT_WIDTH = 400;
const MIN_CHAT_WIDTH = 280;
const MAX_CHAT_WIDTH = 600;

function isDesktopStatic(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(min-width: 768px)").matches;
}

function getCachedState(cwd: string): ChangesState {
  return stateCache.get(cwd) || {
    selectedFile: null,
    checkedFiles: new Set(),
    commitMsg: "",
    commitPanelOpen: isDesktopStatic(),
    pushOnCommit: false,
    stackedMode: true,
    chatWidth: DEFAULT_CHAT_WIDTH,
  };
}

// --- Main Component ---

export function ChangesView({ cwd, sessionId }: { cwd: string; sessionId?: string | null }) {
  const { settings } = useSettings();
  const { setSidebarContent, closeSidebar } = useShell();
  const isDesktop = useIsDesktop();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cached = getCachedState(cwd);
  const [selectedFile, setSelectedFile] = useState<string | null>(cached.selectedFile);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: GitFileChange } | null>(null);
  const [commitMsg, setCommitMsg] = useState(cached.commitMsg);
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(cached.checkedFiles);
  const [pushOnCommit, setPushOnCommit] = useState(cached.pushOnCommit);
  const [commitPanelOpen, setCommitPanelOpen] = useState(cached.commitPanelOpen);
  const [generating, setGenerating] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [stackedMode, setStackedMode] = useState(cached.stackedMode);
  const [chatWidth, setChatWidth] = useState(cached.chatWidth);
  const [scrollToFile, setScrollToFile] = useState<string | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Persist state changes to cache
  useEffect(() => {
    stateCache.set(cwd, { selectedFile, checkedFiles, commitMsg, commitPanelOpen, pushOnCommit, stackedMode, chatWidth });
  }, [cwd, selectedFile, checkedFiles, commitMsg, commitPanelOpen, pushOnCommit, stackedMode, chatWidth]);

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

  // Re-fetch diff for previously selected file on mount (single-file mode)
  useEffect(() => {
    if (selectedFile && !stackedMode) {
      fetchDiff(selectedFile);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFileClick = useCallback((file: GitFileChange) => {
    if (isDesktop && stackedMode) {
      setScrollToFile(file.path);
    } else {
      setSelectedFile(file.path);
      fetchDiff(file.path);
      setContextMenu(null);
      closeSidebar();
    }
  }, [isDesktop, stackedMode, fetchDiff, closeSidebar]);

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

  const handleResize = useCallback((delta: number) => {
    setChatWidth((w) => Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, w + delta)));
  }, []);

  const handleScrolled = useCallback(() => {
    setScrollToFile(null);
  }, []);

  // Push file list into sidebar
  useEffect(() => {
    if (!status || status.files.length === 0) {
      setSidebarContent(null);
      return;
    }
    setSidebarContent(
      <FileList
        files={status.files}
        selectedFile={isDesktop && stackedMode ? null : selectedFile}
        checkedFiles={checkedFiles}
        onFileClick={handleFileClick}
        onContextMenu={handleContextMenu}
        onToggleFile={toggleFile}
        onToggleAll={toggleAll}
      />
    );
    return () => setSidebarContent(null);
  }, [status, selectedFile, checkedFiles, isDesktop, stackedMode, handleFileClick, handleContextMenu, toggleFile, toggleAll, setSidebarContent]);

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

  const showChat = isDesktop && !!sessionId;

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
        {/* Stacked/Single toggle - desktop only */}
        {isDesktop && status.files.length > 0 && (
          <div className="flex items-center gap-0.5 rounded-md border p-0.5">
            <button
              onClick={() => setStackedMode(true)}
              className={cn(
                "rounded px-1.5 py-0.5 text-xs transition-colors",
                stackedMode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
              title="Stacked view"
            >
              <Layers className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setStackedMode(false)}
              className={cn(
                "rounded px-1.5 py-0.5 text-xs transition-colors",
                !stackedMode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
              title="Single file view"
            >
              <List className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
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
        {/* Diff column */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-auto">
            {isDesktop && stackedMode ? (
              <StackedDiffs
                files={status.files}
                cwd={cwd}
                diffStyle={settings.diffStyle}
                scrollToFile={scrollToFile}
                onScrolled={handleScrolled}
              />
            ) : (
              <>
                {diffLoading ? (
                  <div className="flex items-center justify-center h-full">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : selectedFile && diff ? (
                  <div className="p-4">
                    <div className="rounded border overflow-hidden">
                      <DiffErrorBoundary fallback={<pre className="p-4 text-xs text-muted-foreground whitespace-pre-wrap">{diff}</pre>}>
                        <PatchDiff
                          patch={diff}
                          options={{
                            theme: { dark: "pierre-dark", light: "pierre-light" },
                            themeType: isDark() ? "dark" : "light",
                            overflow: "wrap",
                            diffStyle: settings.diffStyle,
                          }}
                        />
                      </DiffErrorBoundary>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full text-sm text-muted-foreground text-center px-4">
                    {status.files.length > 0
                      ? "Select a file from the sidebar to view changes"
                      : "No changes"}
                  </div>
                )}
              </>
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
                      {generating ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      {generating ? "Generating..." : "Generate"}
                    </Button>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                      <Checkbox checked={pushOnCommit} onChange={() => setPushOnCommit(!pushOnCommit)} />
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
        </div>

        {/* Resize handle + Chat panel - desktop only */}
        {showChat && (
          <>
            <ResizeHandle onResize={handleResize} />
            <div
              className="flex flex-col shrink-0 border-l min-h-0"
              style={{ width: chatWidth }}
            >
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
