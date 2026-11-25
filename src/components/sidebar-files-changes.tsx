"use client";

import type { GitStatusEntry } from "@pierre/trees";
import { ExternalLink, Loader2, Plus, Table2 } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "@/components/app-shell";
import { FilePicker } from "@/components/file-picker";
import { SessionFileTree } from "@/components/session-file-tree";
import { SidebarSection } from "@/components/sidebar-section";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { useWebSocket } from "@/hooks/use-websocket";
import { absolutePath, changeDecoration, type SessionPathListing, toTreeGitStatus } from "@/lib/session-tree";

const VIEW_KEY = "cockpit_sidebar_files_changes_view";
const DEBOUNCE_MS = 800;
/** Git is polled rather than pushed: a watcher over a large folder is the very
 *  thing this panel used to make expensive. */
const GIT_POLL_MS = 5_000;

/** Children fetched per folder, folded into one listing for the tree. */
function mergeListing(prev: SessionPathListing, next: SessionPathListing): SessionPathListing {
  return {
    paths: [...new Set([...prev.paths, ...next.paths])],
    ignored: [...new Set([...prev.ignored, ...next.ignored])],
    truncated: prev.truncated || next.truncated,
  };
}

type View = "changes" | "files";

interface GitFileChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

interface GitStatus {
  branch: string;
  files: GitFileChange[];
}

const LEGEND = [
  { glyph: "M", colour: "text-yellow-500", label: "Modified", description: "Tracked file with uncommitted changes." },
  { glyph: "A", colour: "text-green-500", label: "Added", description: "New file staged in the working tree." },
  { glyph: "D", colour: "text-red-500", label: "Deleted", description: "Tracked file removed from the working tree." },
  { glyph: "R", colour: "text-blue-500", label: "Renamed", description: "Tracked file moved or renamed." },
  { glyph: "U", colour: "text-green-500", label: "Untracked", description: "New file not yet tracked by Git." },
  { glyph: "I", colour: "text-muted-foreground", label: "Ignored", description: "Excluded by .gitignore; shown muted." },
  { glyph: "●", colour: "text-yellow-500", label: "Folder", description: "Contains changed files." },
] as const;

function storedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "files" ? "files" : "changes";
  } catch {
    return "changes";
  }
}

function isMobile(): boolean {
  return typeof window !== "undefined" && window.innerWidth < 768;
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-8">
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * The session sidebar's Files & changes panel. One section, two views: git
 * status for the session's directory, or every file in it, both drawn by the
 * same file tree. The chosen view is remembered.
 */
export function SidebarFilesChanges({ cwd }: { cwd: string }) {
  const pathname = usePathname();
  const { tabActions, closeSidebar } = useShell();
  const [view, setView] = useState<View>("changes");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(() => {
    setView(storedView());
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // storage unavailable: the choice lasts as long as this page does
    }
  }, [view]);

  const fetchStatus = useCallback(() => {
    // fs_changed fires for every watched session and a session switch can
    // leave an older request in flight; a late answer must not replace the
    // current directory's status.
    const target = cwdRef.current;
    fetch(`/api/git/status?cwd=${encodeURIComponent(target)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Not a git repository");
        return res.json() as Promise<GitStatus>;
      })
      .then((data) => {
        if (cwdRef.current !== target) return;
        setStatus(data);
        setStatusError(null);
      })
      .catch((err: unknown) => {
        if (cwdRef.current !== target) return;
        setStatus(null);
        setStatusError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (cwdRef.current === target) setStatusLoading(false);
      });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: cwd and pathname are the triggers; the fetch reads them through cwdRef
  useEffect(() => {
    setStatusLoading(true);
    fetchStatus();
  }, [cwd, pathname, fetchStatus]);

  // Git is the source of truth for changes, so the panel asks it directly.
  // Polling only while the page is visible keeps a session the user has left
  // from costing a `git status` every few seconds.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") fetchStatus();
    }, GIT_POLL_MS);
    return () => clearInterval(timer);
  }, [fetchStatus]);

  const changedPaths = useMemo(() => status?.files.map((file) => file.path) ?? [], [status]);

  const gitStatus = useMemo<GitStatusEntry[]>(
    () => (status?.files ?? []).map((file) => ({ path: file.path, status: toTreeGitStatus(file.status) })),
    [status],
  );

  const decorations = useMemo(() => {
    const map = new Map<string, { text: string; title: string }>();
    for (const file of status?.files ?? []) {
      const decoration = changeDecoration(file);
      if (decoration) map.set(file.path, decoration);
    }
    return map;
  }, [status]);

  const deletedPaths = useMemo(
    () => new Set((status?.files ?? []).filter((file) => file.status === "deleted").map((file) => file.path)),
    [status],
  );

  const openPath = useCallback(
    (path: string) => {
      if (view === "changes") tabActions?.openDiff(path);
      else tabActions?.openFile(absolutePath(cwd, path));
      if (isMobile()) closeSidebar();
    },
    [view, cwd, tabActions, closeSidebar],
  );

  const openPickedFile = useCallback(
    (path: string) => {
      tabActions?.openFile(path);
      setPickerOpen(false);
      if (isMobile()) closeSidebar();
    },
    [tabActions, closeSidebar],
  );

  const totalAdded = (status?.files ?? []).reduce((sum, file) => sum + file.additions, 0);
  const totalDeleted = (status?.files ?? []).reduce((sum, file) => sum + file.deletions, 0);

  return (
    <>
      <SidebarSection
        id="files-changes"
        title="Files & changes"
        badge={status && status.files.length > 0 ? String(status.files.length) : undefined}
        defaultOpen={false}
        actions={
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            title="Open file"
            className="flex items-center justify-center rounded p-0.5 text-muted-foreground hover:bg-accent"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        }
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Segmented
            value={view}
            options={[
              { value: "changes", label: "Changes" },
              { value: "files", label: "Files" },
            ]}
            onChange={setView}
            label="Files and changes"
            testId="sidebar-files-changes-switch"
            variant="track"
          />
        </div>

        {view === "changes" ? (
          <ChangesBody
            status={status}
            error={statusError}
            loading={statusLoading}
            paths={changedPaths}
            gitStatus={gitStatus}
            decorations={decorations}
            onOpen={openPath}
            onOpenChanges={() => tabActions?.openChanges()}
            onOpenLegend={() => setLegendOpen(true)}
            totalAdded={totalAdded}
            totalDeleted={totalDeleted}
          />
        ) : (
          <FilesBody cwd={cwd} deletedPaths={deletedPaths} gitStatus={gitStatus} decorations={decorations} onOpen={openPath} />
        )}
      </SidebarSection>

      <Dialog open={legendOpen} onOpenChange={setLegendOpen}>
        <DialogContent className="sm:max-w-md" data-testid="sidebar-changes-legend-dialog">
          <DialogHeader>
            <DialogTitle>Change legend</DialogTitle>
          </DialogHeader>
          <dl className="space-y-2 text-sm" data-testid="sidebar-changes-legend-list">
            {LEGEND.map((item) => (
              <div key={item.label} className="flex items-start gap-3">
                <dt className={`w-4 shrink-0 text-center font-mono font-semibold ${item.colour}`}>{item.glyph}</dt>
                <dd className="min-w-0">
                  <span className="font-medium">{item.label}</span> <span className="text-muted-foreground">{item.description}</span>
                </dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Open File</DialogTitle>
          </DialogHeader>
          <FilePicker startPath={cwd} onSelect={openPickedFile} onCancel={() => setPickerOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function ChangesBody({
  status,
  error,
  loading,
  paths,
  gitStatus,
  decorations,
  onOpen,
  onOpenChanges,
  onOpenLegend,
  totalAdded,
  totalDeleted,
}: {
  status: GitStatus | null;
  error: string | null;
  loading: boolean;
  paths: readonly string[];
  gitStatus: readonly GitStatusEntry[];
  decorations: ReadonlyMap<string, { text: string; title: string }>;
  onOpen: (path: string) => void;
  onOpenChanges: () => void;
  onOpenLegend: () => void;
  totalAdded: number;
  totalDeleted: number;
}) {
  if (loading && !status) return <Spinner />;
  if (error) return <p className="px-3 py-3 text-sm text-muted-foreground">{error}</p>;
  if (paths.length === 0) return <p className="px-3 py-3 text-sm text-muted-foreground">Working tree clean</p>;

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5 text-xs text-muted-foreground">
        {status?.branch && (
          <>
            <span>Branch:</span>
            <span className="min-w-0 truncate font-mono font-bold text-foreground">{status.branch}</span>
            <span>·</span>
          </>
        )}
        <span className="shrink-0">{paths.length} changed</span>
        {totalAdded > 0 && <span className="shrink-0 text-green-500">+{totalAdded}</span>}
        {totalDeleted > 0 && <span className="shrink-0 text-red-500">-{totalDeleted}</span>}
        <button
          type="button"
          title="Change legend"
          aria-label="Change legend"
          onClick={onOpenLegend}
          data-testid="sidebar-changes-legend"
          className="ml-auto shrink-0 hover:text-foreground"
        >
          <Table2 className="h-3 w-3" />
        </button>
        <button type="button" title="Open commit view" onClick={onOpenChanges} className="shrink-0 hover:text-foreground">
          <ExternalLink className="h-3 w-3" />
        </button>
      </div>
      <SessionFileTree mode="changes" paths={paths} gitStatus={gitStatus} decorations={decorations} onOpen={onOpen} />
    </>
  );
}

function FilesBody({
  cwd,
  deletedPaths,
  gitStatus,
  decorations,
  onOpen,
}: {
  cwd: string;
  deletedPaths: ReadonlySet<string>;
  gitStatus: readonly GitStatusEntry[];
  decorations: ReadonlyMap<string, { text: string; title: string }>;
  onOpen: (path: string) => void;
}) {
  const pathname = usePathname();
  const { send, subscribe, connected } = useWebSocket();
  const [listing, setListing] = useState<SessionPathListing | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<readonly string[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  /** Folders whose children are in `listing`, so expanding one fetches once. */
  const loadedDirs = useRef<Set<string>>(new Set());
  const expandedDirsRef = useRef<readonly string[]>([]);

  const loadDir = useCallback(async (dir: string, target: string): Promise<SessionPathListing | null> => {
    try {
      const res = await fetch(`/api/filesystem/tree?cwd=${encodeURIComponent(target)}&dir=${encodeURIComponent(dir)}`);
      if (!res.ok) throw new Error("Cannot list this folder");
      const data = (await res.json()) as SessionPathListing;
      return cwdRef.current === target ? data : null;
    } catch {
      return null;
    }
  }, []);

  /** Re-read the top level and every folder that is open, dropping entries
   *  that have gone. The Files tree is lazy: only what is on screen is read. */
  const reload = useCallback(async () => {
    const target = cwdRef.current;
    const dirs = ["", ...expandedDirsRef.current];
    const results = await Promise.all(dirs.map((dir) => loadDir(dir, target)));
    if (cwdRef.current !== target) return null;
    const root = results[0];
    if (!root) {
      setListing(null);
      setError(true);
      setLoading(false);
      return null;
    }
    loadedDirs.current = new Set(dirs);
    setListing(results.filter((r): r is SessionPathListing => !!r).reduce(mergeListing, { paths: [], ignored: [], truncated: false }));
    setError(false);
    setLoading(false);
    return root;
  }, [loadDir]);

  const onExpandedDirsChange = useCallback(
    (dirs: readonly string[]) => {
      setExpandedDirs(dirs);
      expandedDirsRef.current = dirs;
      const target = cwdRef.current;
      for (const dir of dirs) {
        if (loadedDirs.current.has(dir)) continue;
        loadedDirs.current.add(dir);
        void loadDir(dir, target).then((data) => {
          if (!data || cwdRef.current !== target) {
            loadedDirs.current.delete(dir);
            return;
          }
          setListing((prev) => (prev ? mergeListing(prev, data) : data));
        });
      }
    },
    [loadDir],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: cwd and pathname are the triggers; the fetch reads them through cwdRef
  useEffect(() => {
    setLoading(true);
    setListing(null);
    setExpandedDirs([]);
    expandedDirsRef.current = [];
    loadedDirs.current = new Set();
    void reload();
  }, [cwd, pathname, reload]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe((msg) => {
      if (msg.type !== "session:fs_changed" || msg.cwd !== cwdRef.current) return;
      // A session writing files fires this often; one re-read after the flurry
      // is enough, and the tree keeps its expansion while the list is unchanged.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void reload();
      }, DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [subscribe, reload]);

  // Only the folders on screen need live updates, so the tree reports its
  // expansion and the server watches exactly those. "" is the session folder
  // itself, which is always watched so a new top-level file appears.
  // biome-ignore lint/correctness/useExhaustiveDependencies: connected re-sends after a reconnect, which drops the server's per-connection watches
  useEffect(() => {
    send({ type: "watch:dirs", cwd, dirs: ["", ...expandedDirs] });
  }, [send, cwd, expandedDirs, connected]);

  useEffect(() => {
    return () => {
      send({ type: "watch:dirs", cwd, dirs: [] });
    };
  }, [send, cwd]);

  const paths = useMemo(() => (listing?.paths ?? []).filter((path) => !deletedPaths.has(path)), [listing, deletedPaths]);

  const filesGitStatus = useMemo<GitStatusEntry[]>(
    () => [...gitStatus, ...(listing?.ignored ?? []).map((path) => ({ path, status: "ignored" as const }))],
    [gitStatus, listing],
  );

  if (loading && !listing) return <Spinner />;
  if (error) return <p className="px-3 py-3 text-sm text-muted-foreground">Cannot list this folder</p>;
  if (paths.length === 0) return <p className="px-3 py-3 text-sm text-muted-foreground">Empty directory</p>;

  return (
    <>
      <SessionFileTree
        mode="files"
        paths={paths}
        gitStatus={filesGitStatus}
        decorations={decorations}
        onOpen={onOpen}
        onExpandedDirsChange={onExpandedDirsChange}
      />
      {listing?.truncated && (
        <p className="border-t px-3 py-1.5 text-[10px] text-muted-foreground">Showing the first {paths.length.toLocaleString()} files.</p>
      )}
    </>
  );
}
