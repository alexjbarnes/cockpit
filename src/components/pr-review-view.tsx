"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { FileDiff as FileDiffComponent, PatchDiff } from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { useSettings } from "@/hooks/use-settings";
import { DiffErrorBoundary, DIFF_SELECTABLE_CSS } from "@/components/diff-viewer";
import { useShell } from "@/components/app-shell";
import { usePageHeader } from "@/components/app-shell";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { ChatView } from "@/components/chat-view";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  ArrowLeft,
  ExternalLink,
  GitBranch,
  Check,
  ChevronDown,
  ChevronUp,
  FileEdit,
  FilePlus,
  FileMinus,
  FileSymlink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { pinSession } from "@/components/sidebar";

// --- Types ---

interface PRFile {
  path: string;
  additions: number;
  deletions: number;
}

interface PRDetails {
  title: string;
  body: string;
  author: { login: string };
  number: number;
  additions: number;
  deletions: number;
  files: PRFile[];
  changedFiles: number;
  headRefName: string;
  baseRefName: string;
  state: string;
  isDraft: boolean;
  labels: { name: string; color: string }[];
  reviewDecision: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

interface FileDiff {
  path: string;
  patch: string;
}

// --- Utilities ---

function isDark(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

function fileStatusIcon(path: string, prFiles: PRFile[]) {
  const f = prFiles.find((pf) => pf.path === path);
  if (!f) return <FileEdit className="h-3.5 w-3.5 text-yellow-500 shrink-0" />;
  if (f.deletions === 0 && f.additions > 0) return <FilePlus className="h-3.5 w-3.5 text-green-500 shrink-0" />;
  if (f.additions === 0 && f.deletions > 0) return <FileMinus className="h-3.5 w-3.5 text-red-500 shrink-0" />;
  return <FileEdit className="h-3.5 w-3.5 text-yellow-500 shrink-0" />;
}

function isDeletedFile(patch: string): boolean {
  return /^deleted file mode/m.test(patch);
}

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "avif",
  "woff", "woff2", "ttf", "eot", "otf",
  "zip", "gz", "tar", "bz2", "7z", "rar",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "mp3", "mp4", "wav", "avi", "mov", "mkv", "webm",
  "exe", "dll", "so", "dylib",
]);

function isBinaryFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXTENSIONS.has(ext);
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

// --- Session Storage ---

const SESSIONS_KEY = "cockpit_review_sessions";
const VIEWED_KEY_PREFIX = "cockpit_review_viewed:";

function getSessionMapping(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

function setSessionMapping(key: string, sessionId: string) {
  const mapping = getSessionMapping();
  mapping[key] = sessionId;
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(mapping));
}

function getViewedFiles(prKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(VIEWED_KEY_PREFIX + prKey);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

function setViewedFiles(prKey: string, files: Set<string>) {
  localStorage.setItem(VIEWED_KEY_PREFIX + prKey, JSON.stringify([...files]));
}

// --- State Cache ---

interface ReviewState {
  chatWidth: number;
  descriptionOpen: boolean;
}

const stateCache = new Map<string, ReviewState>();
const DEFAULT_CHAT_WIDTH = 400;
const MIN_CHAT_WIDTH = 280;

function maxChatWidth(): number {
  if (typeof window === "undefined") return 800;
  return Math.floor(window.innerWidth * 0.5);
}

function getCachedState(prKey: string): ReviewState {
  return stateCache.get(prKey) || {
    chatWidth: DEFAULT_CHAT_WIDTH,
    descriptionOpen: true,
  };
}

// --- Lazy Diff ---

function fetchFileContent(repo: string, path: string, ref: string): Promise<string | null> {
  return fetch(
    `/api/github/file-content?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`,
  )
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => data?.content ?? null)
    .catch(() => null);
}

function LazyDiff({
  file,
  pr,
  repo,
  settings,
  viewed,
  collapsed,
  onToggleViewed,
  onToggleCollapse,
  sectionRef,
}: {
  file: FileDiff;
  pr: PRDetails | null;
  repo: string;
  settings: { diffStyle: string };
  viewed: boolean;
  collapsed: boolean;
  onToggleViewed: () => void;
  onToggleCollapse: () => void;
  sectionRef: (el: HTMLDivElement | null) => void;
}) {
  const deleted = isDeletedFile(file.patch);
  const binary = isBinaryFile(file.path);
  const [loadDeleted, setLoadDeleted] = useState(false);
  const [loadBinary, setLoadBinary] = useState(false);
  const [visible, setVisible] = useState(false);
  const [fileDiffMeta, setFileDiffMeta] = useState<FileDiffMetadata | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (deleted && !loadDeleted) return;
    if (binary && !loadBinary) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [deleted, loadDeleted, binary, loadBinary]);

  // When visible, parse patch and fetch full file contents for context expansion
  useEffect(() => {
    if (!visible || !pr) return;

    let cancelled = false;

    // Parse patch into FileDiffMetadata
    let meta: FileDiffMetadata | null = null;
    try {
      const parsed = parsePatchFiles(file.patch);
      if (parsed.length > 0 && parsed[0].files.length > 0) {
        meta = parsed[0].files[0];
      }
    } catch (e) {
      console.warn(`[diff] parsePatchFiles failed for ${file.path}:`, e);
    }

    if (!meta) {
      console.warn(`[diff] no meta for ${file.path}, falling back to PatchDiff`);
      return;
    }

    // Fetch old (base) and new (head) file contents in parallel
    Promise.all([
      fetchFileContent(repo, file.path, pr.baseRefName),
      fetchFileContent(repo, file.path, pr.headRefName),
    ]).then(([oldContent, newContent]) => {
      if (cancelled) return;
      if (oldContent != null) {
        meta!.oldLines = oldContent.split("\n").map((l) => l + "\n");
      } else {
        console.warn(`[diff] ${file.path}: oldContent is null (base=${pr.baseRefName})`);
      }
      if (newContent != null) {
        meta!.newLines = newContent.split("\n").map((l) => l + "\n");
      } else {
        console.warn(`[diff] ${file.path}: newContent is null (head=${pr.headRefName})`);
      }
      console.info(`[diff] ${file.path}: oldLines=${!!meta!.oldLines} newLines=${!!meta!.newLines}`);
      setFileDiffMeta(meta);
    }).catch((e) => {
      console.error(`[diff] fetch failed for ${file.path}:`, e);
    });

    return () => { cancelled = true; };
  }, [visible, pr, repo, file.patch, file.path]);

  const handleMarkViewed = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleViewed();
    if (!collapsed) onToggleCollapse();
  };

  const diffOptions = {
    theme: { dark: "pierre-dark", light: "pierre-light" },
    themeType: isDark() ? ("dark" as const) : ("light" as const),
    overflow: "wrap" as const,
    diffStyle: settings.diffStyle as "split" | "unified",
    hunkSeparators: "line-info" as const,
    expansionLineCount: 20,
    disableFileHeader: true,
    unsafeCSS: DIFF_SELECTABLE_CSS,
  };

  return (
    <div
      ref={(el) => { sentinelRef.current = el; sectionRef(el); }}
      className={cn("rounded border overflow-clip", viewed && "opacity-60")}
    >
      {collapsed ? (
        <button
          onClick={onToggleCollapse}
          className="flex items-center gap-2 w-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          {viewed && <Check className="h-3 w-3 text-green-500 shrink-0" />}
          <span className="font-mono text-xs truncate text-left" dir="rtl" title={file.path}><bdo dir="ltr">{file.path}</bdo></span>
        </button>
      ) : deleted && !loadDeleted ? (
        <button
          onClick={() => setLoadDeleted(true)}
          className="flex items-center gap-2 w-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <FileMinus className="h-3.5 w-3.5 text-red-500 shrink-0" />
          <span className="font-mono text-xs truncate text-left" dir="rtl" title={file.path}><bdo dir="ltr">{file.path}</bdo></span>
          <span className="text-xs shrink-0">deleted &mdash; click to load</span>
        </button>
      ) : binary && !loadBinary ? (
        <button
          onClick={() => setLoadBinary(true)}
          className="flex items-center gap-2 w-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          {fileStatusIcon(file.path, pr?.files || [])}
          <span className="font-mono text-xs truncate text-left" dir="rtl" title={file.path}><bdo dir="ltr">{file.path}</bdo></span>
          <span className="text-xs shrink-0">binary &mdash; click to load</span>
        </button>
      ) : !visible ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-1.5 text-sm border-b bg-muted/80 backdrop-blur-sm">
            {fileStatusIcon(file.path, pr?.files || [])}
            <span className="font-mono text-xs truncate flex-1 min-w-0 text-left" dir="rtl" title={file.path}><bdo dir="ltr">{file.path}</bdo></span>
            <button
              onClick={handleMarkViewed}
              className={cn(
                "h-4 w-4 shrink-0 rounded border flex items-center justify-center transition-colors",
                viewed
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-muted-foreground/40 bg-transparent hover:border-muted-foreground/60",
              )}
              title="Mark as viewed and collapse"
            >
              {viewed && <Check className="h-3 w-3" strokeWidth={3} />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              title="Collapse"
            >
              <ChevronUp className="h-3 w-3" />
            </button>
            {pr && (
              <a
                href={`${pr.url}/files#diff-${file.path}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <DiffErrorBoundary fallback={<pre className="p-4 text-xs text-muted-foreground whitespace-pre-wrap">{file.patch}</pre>}>
            {fileDiffMeta ? (
              <FileDiffComponent
                fileDiff={fileDiffMeta}
                options={diffOptions}
              />
            ) : (
              <PatchDiff
                patch={file.patch}
                options={diffOptions}
              />
            )}
          </DiffErrorBoundary>
        </>
      )}
    </div>
  );
}

// --- Main Component ---

export function PRReviewView({ owner, repo, number }: { owner: string; repo: string; number: number }) {
  const fullRepo = `${owner}/${repo}`;
  const prKey = `${fullRepo}#${number}`;

  const { settings } = useSettings();
  const { setSidebarContent } = useShell();
  const router = useRouter();
  const isDesktop = useIsDesktop();

  const [pr, setPr] = useState<PRDetails | null>(null);
  const [fileDiffs, setFileDiffs] = useState<FileDiff[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cached = getCachedState(prKey);
  const [chatWidth, setChatWidth] = useState(cached.chatWidth);
  const [descriptionOpen, setDescriptionOpen] = useState(cached.descriptionOpen);
  const [scrollToFile, setScrollToFile] = useState<string | null>(null);
  const [viewedFiles, setViewedFilesState] = useState<Set<string>>(() => getViewedFiles(prKey));

  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [reviewsCwd, setReviewsCwd] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);

  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  usePageHeader(pr ? `#${number} ${pr.title}` : `PR #${number}`);

  // Persist state
  useEffect(() => {
    stateCache.set(prKey, { chatWidth, descriptionOpen });
  }, [prKey, chatWidth, descriptionOpen]);

  // Fetch PR details + diff in parallel
  useEffect(() => {
    setLoading(true);
    setError(null);

    const fetchDetails = fetch(`/api/github/prs/view?repo=${encodeURIComponent(fullRepo)}&number=${number}`)
      .then((res) => {
        if (!res.ok) return res.json().then((d) => Promise.reject(d.error));
        return res.json();
      });

    const fetchDiff = fetch(`/api/github/prs/diff?repo=${encodeURIComponent(fullRepo)}&number=${number}`)
      .then((res) => {
        if (!res.ok) return res.json().then((d) => Promise.reject(d.error));
        return res.json();
      });

    Promise.all([fetchDetails, fetchDiff])
      .then(([details, diffData]) => {
        setPr(details);
        setFileDiffs(diffData.files || []);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [fullRepo, number]);

  // Resolve or create session
  useEffect(() => {
    if (!pr) return;
    const prTitle = pr.title;

    async function resolveSession() {
      setSessionLoading(true);
      const mapping = getSessionMapping();
      const existingId = mapping[prKey];

      if (existingId) {
        // Verify session still exists
        try {
          const res = await fetch(`/api/sessions/${existingId}`);
          if (res.ok) {
            setSessionId(existingId);
            const data = await res.json();
            setReviewsCwd(data.session?.cwd || null);
            pinSession(existingId);
            setSessionLoading(false);
            return;
          }
        } catch {}
      }

      // Create new session
      try {
        const res = await fetch("/api/github/review-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: fullRepo, prNumber: number, prTitle }),
        });
        if (res.ok) {
          const data = await res.json();
          setSessionId(data.sessionId);
          setReviewsCwd(data.cwd);
          setSessionMapping(prKey, data.sessionId);
          pinSession(data.sessionId);
        }
      } catch {}
      setSessionLoading(false);
    }

    resolveSession();
  }, [pr, prKey, fullRepo, number]);

  // Scroll to file
  useEffect(() => {
    if (!scrollToFile) return;
    const el = sectionRefs.current.get(scrollToFile);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    setScrollToFile(null);
  }, [scrollToFile]);

  // Toggle viewed
  const toggleViewed = useCallback((path: string) => {
    setViewedFilesState((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      setViewedFiles(prKey, next);
      return next;
    });
  }, [prKey]);

  // Mark as viewed (always adds, never removes)
  const markViewed = useCallback((path: string) => {
    setViewedFilesState((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      setViewedFiles(prKey, next);
      return next;
    });
  }, [prKey]);

  // Toggle collapse
  const toggleCollapse = useCallback((path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Resize handler
  const handleResize = useCallback((delta: number) => {
    setChatWidth((prev) => Math.max(MIN_CHAT_WIDTH, Math.min(maxChatWidth(), prev + delta)));
  }, []);

  // Sidebar file list
  useEffect(() => {
    if (fileDiffs.length === 0) {
      setSidebarContent(null);
      return;
    }

    setSidebarContent(
      <>
        <div className="sticky top-0 bg-background flex items-center justify-between px-3 py-2 border-b z-10">
          <span className="text-sm font-bold">Files</span>
          <span className="text-xs text-muted-foreground">{fileDiffs.length} changed</span>
        </div>
        {fileDiffs.map((file) => (
          <div
            key={file.path}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer border-b last:border-b-0 hover:bg-muted/50",
              viewedFiles.has(file.path) && "opacity-50",
            )}
            onClick={() => {
              if (collapsedFiles.has(file.path)) toggleCollapse(file.path);
              setScrollToFile(file.path);
            }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleViewed(file.path);
                if (!viewedFiles.has(file.path) && !collapsedFiles.has(file.path)) {
                  toggleCollapse(file.path);
                }
              }}
              className={cn(
                "h-4 w-4 shrink-0 rounded border flex items-center justify-center transition-colors",
                viewedFiles.has(file.path)
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-muted-foreground/40 bg-transparent hover:border-muted-foreground/60",
              )}
            >
              {viewedFiles.has(file.path) && <Check className="h-3 w-3" strokeWidth={3} />}
            </button>
            {fileStatusIcon(file.path, pr?.files || [])}
            <span className="font-mono text-xs truncate flex-1 min-w-0 text-left" dir="rtl" title={file.path}><bdo dir="ltr">{file.path}</bdo></span>
            {pr?.files && (() => {
              const f = pr.files.find((pf) => pf.path === file.path);
              if (!f) return null;
              return (
                <span className="text-xs font-mono shrink-0 flex gap-1">
                  {f.additions > 0 && <span className="text-green-500">+{f.additions}</span>}
                  {f.deletions > 0 && <span className="text-red-500">-{f.deletions}</span>}
                </span>
              );
            })()}
          </div>
        ))}
      </>,
    );

    return () => setSidebarContent(null);
  }, [fileDiffs, pr, viewedFiles, collapsedFiles, setSidebarContent, toggleViewed, toggleCollapse]);

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 p-4">
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      </div>
    );
  }

  if (!pr) return null;

  const showChat = isDesktop && !!sessionId && !sessionLoading;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header bar */}
      <div className="shrink-0 border-b px-4 py-2 flex items-center gap-3 text-sm">
        <Button variant="ghost" size="icon" className="shrink-0 h-7 w-7" onClick={() => router.push(`/reviews/${owner}/${repo}`)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="text-muted-foreground">{pr.author.login}</span>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <GitBranch className="h-3 w-3" />
          <span>{pr.headRefName}</span>
          <span className="mx-1">into</span>
          <span>{pr.baseRefName}</span>
        </div>
        {pr.isDraft && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">Draft</span>
        )}
        {pr.reviewDecision === "APPROVED" && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-500">Approved</span>
        )}
        {pr.reviewDecision === "CHANGES_REQUESTED" && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-500">Changes requested</span>
        )}
        <div className="flex items-center gap-2 ml-auto text-xs text-muted-foreground">
          <span className="text-green-500">+{pr.additions}</span>
          <span className="text-red-500">-{pr.deletions}</span>
          <span>{pr.changedFiles} files</span>
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 min-h-0 flex flex-row">
        {/* Diff column */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {/* PR description */}
          {pr.body && (
            <div className="border-b">
              <button
                onClick={() => setDescriptionOpen((v) => !v)}
                className="flex items-center gap-2 w-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {descriptionOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                Description
              </button>
              {descriptionOpen && (
                <div className="px-4 pb-3 text-sm prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">
                  {pr.body}
                </div>
              )}
            </div>
          )}

          {/* Labels */}
          {pr.labels.length > 0 && (
            <div className="flex gap-1 px-4 py-2 flex-wrap border-b">
              {pr.labels.map((label) => (
                <span
                  key={label.name}
                  className="text-[10px] px-1.5 py-0.5 rounded-full border"
                  style={{ borderColor: `#${label.color}`, color: `#${label.color}` }}
                >
                  {label.name}
                </span>
              ))}
            </div>
          )}

          {/* Stacked diffs */}
          <div className="p-4 space-y-3">
            {fileDiffs.length === 0 && (
              <div className="text-center py-12 text-sm text-muted-foreground">No changes</div>
            )}
            {fileDiffs.map((file) => (
              <LazyDiff
                key={file.path}
                file={file}
                pr={pr}
                repo={fullRepo}
                settings={settings}
                viewed={viewedFiles.has(file.path)}
                collapsed={collapsedFiles.has(file.path)}
                onToggleViewed={() => markViewed(file.path)}
                onToggleCollapse={() => toggleCollapse(file.path)}
                sectionRef={(el) => { if (el) sectionRefs.current.set(file.path, el); }}
              />
            ))}
          </div>
        </div>

        {/* Chat panel - desktop only */}
        {showChat && reviewsCwd && (
          <>
            <ResizeHandle onResize={handleResize} />
            <div className="flex flex-col shrink-0 border-l min-h-0" style={{ width: chatWidth }}>
              <ChatView
                sessionId={sessionId}
                cwd={reviewsCwd}
                initialContext={`Reviewing PR #${number}: ${pr.title}\nRepo: ${fullRepo}\nAuthor: ${pr.author.login}\nBranch: ${pr.headRefName} into ${pr.baseRefName}\nFiles changed: ${pr.changedFiles} (+${pr.additions} -${pr.deletions})${pr.body ? `\n\nDescription:\n${pr.body.slice(0, 2000)}` : ""}`}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
