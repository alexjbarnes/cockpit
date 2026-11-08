"use client";

import { ClipboardList, Loader2, Plus, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "@/components/app-shell";
import { IssueList } from "@/components/issues/issue-list";
import { NewIssueDialog } from "@/components/issues/new-issue-dialog";
import { Button } from "@/components/ui/button";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import { useSettings } from "@/hooks/use-settings";
import { groupIssuesByStatus, type IssuePlacement, projectForCwd, resolveProjectStatuses } from "@/lib/issue-display";
import { mergeIssueChanges, resolveIssueDrop, sendIssuePlacement } from "@/lib/issue-drag";
import { createStaleGuard } from "@/lib/stale-guard";
import { cn } from "@/lib/utils";
import type { Issue, Project } from "@/types";

const COLLAPSED_GROUPS_KEY = "cockpit_session_issue_collapsed";
const EMPTY_STATUS_SET: ReadonlySet<string> = new Set();

/**
 * The session header's way into its project's issues: the ones belonging to the
 * repository this session is working in, over the top of the session, draggable
 * the same way the Issues page is. The project is a picker rather than a
 * fixed lookup — a project may have no repo path set, or the session may be
 * outside every repo, and neither should leave the button dead.
 */
export function SessionIssuesButton() {
  const { cwd, openPageModal } = useShell();
  const pathname = usePathname();
  const { settings, loaded, reload } = useSettings();
  // Open state lives in the URL (?issues=1) so that coming back from an issue —
  // the browser's Back, or the issue page's — reopens the list it was opened
  // from, instead of landing on the session with the modal gone.
  const [open, setOpen] = useState(false);

  // The insert hand-off closes the list first, but the page modal then takes
  // its history entry back off; the popstate that follows would read the old
  // URL (still ?issues=1) and reopen what the user just left.
  const skipNextSync = useRef(false);
  const syncOpenFromUrl = useCallback(() => {
    if (skipNextSync.current) {
      skipNextSync.current = false;
      return;
    }
    setOpen(new URLSearchParams(window.location.search).get("issues") === "1");
  }, []);

  useEffect(() => {
    syncOpenFromUrl();
    window.addEventListener("popstate", syncOpenFromUrl);
    return () => window.removeEventListener("popstate", syncOpenFromUrl);
  }, [syncOpenFromUrl]);

  const [issues, setIssues] = useState<Issue[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  // Null until chosen: "" is a choice (All projects), not the absence of one.
  const [projectId, setProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  // Which status sections are folded, remembered across opens and reloads.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string> | null>(null);
  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? "[]");
      setCollapsedGroups(new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []));
    } catch {
      setCollapsedGroups(new Set());
    }
  }, []);
  useEffect(() => {
    if (!collapsedGroups) return;
    try {
      localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...collapsedGroups]));
    } catch {
      // storage unavailable: the choice lasts as long as this page does
    }
  }, [collapsedGroups]);
  // A delete inside the page modal happens without this list remounting, so
  // drop the row when the issue page says it is gone.
  useEffect(() => {
    const onIssueDeleted = (event: Event) => {
      const key = (event as CustomEvent<{ key?: string }>).detail?.key;
      if (!key) return;
      setIssues((prev) => prev.filter((issue) => issue.key !== key));
    };
    // The issue page in the page modal asks for its key to go to the composer:
    // close this list so the composer behind it is what the user sees.
    const onInsert = () => {
      skipNextSync.current = true;
      setOpen(false);
      const params = new URLSearchParams(window.location.search);
      params.delete("issues");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    };
    window.addEventListener("cockpit:issue-deleted", onIssueDeleted);
    window.addEventListener("cockpit:insert-issue", onInsert);
    return () => {
      window.removeEventListener("cockpit:issue-deleted", onIssueDeleted);
      window.removeEventListener("cockpit:insert-issue", onInsert);
    };
  }, []);
  const toggleGroup = useCallback((status: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);
  const dropGuard = useRef(createStaleGuard()).current;

  // Where the list was, kept for this session's tab, so coming back from an
  // issue (Back, or deleting it) finds the list as it was left: the same
  // project and the same scroll position. Opening the list afresh forgets both.
  const scrollKey = `session-issues-scroll:${pathname ?? ""}`;
  const projectKey = `session-issues-project:${pathname ?? ""}`;
  const listRef = useScrollRestoration<HTMLDivElement>(scrollKey);

  const setOpenInUrl = useCallback(
    (next: boolean) => {
      if (!next) {
        setProjectId(null);
        setNewOpen(false);
        // After the list has unmounted: on its way out the scroll restorer
        // saves the position one last time, which would undo an earlier remove.
        setTimeout(() => {
          try {
            sessionStorage.removeItem(scrollKey);
            sessionStorage.removeItem(projectKey);
          } catch {
            // storage unavailable: nothing to forget
          }
        }, 0);
      }
      // Opening always starts from a loading body: the previous open's rows
      // would otherwise paint for a frame, then be replaced by fresh ones.
      if (next) setLoading(true);
      const params = new URLSearchParams(window.location.search);
      if (next) params.set("issues", "1");
      else params.delete("issues");
      const query = params.toString();
      // replaceState, not a router push: this is a query flag the page reads, and
      // it must not add a history entry of its own between the session and Back.
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
      setOpen(next);
    },
    [scrollKey, projectKey],
  );

  // The shell's settings are its own instance of the hook, so a toggle in
  // Settings would leave this button stale until a reload; the sidebar has the
  // same problem and solves it by reloading on navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => {
    reload();
  }, [pathname, reload]);

  const matched = useMemo(() => projectForCwd(projects, cwd), [projects, cwd]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [issuesRes, projectsRes] = await Promise.all([fetch("/api/issues"), fetch("/api/projects")]);
      // Read both bodies before touching state. Setting issues first let the
      // list paint in the canonical status order while projects (and so the
      // project's stored order) had not arrived yet, then jump to its order.
      const [issuesData, projectsData] = await Promise.all([
        issuesRes.ok ? (issuesRes.json() as Promise<{ issues?: Issue[] }>) : Promise.resolve({ issues: [] }),
        projectsRes.ok ? (projectsRes.json() as Promise<{ projects?: Project[] }>) : Promise.resolve({ projects: [] }),
      ]);
      setIssues(issuesData.issues ?? []);
      setProjects(projectsData.projects ?? []);
      setProjectId((current) => {
        if (current !== null) return current;
        let stored: string | null = null;
        try {
          stored = sessionStorage.getItem(projectKey);
        } catch {
          // storage unavailable: fall back to this session's project
        }
        return stored ?? projectForCwd(projectsData.projects ?? [], cwd)?.id ?? "";
      });
    } finally {
      setLoading(false);
    }
  }, [cwd, projectKey]);

  const chooseProject = useCallback(
    (id: string) => {
      setProjectId(id);
      try {
        sessionStorage.setItem(projectKey, id);
      } catch {
        // storage unavailable: the choice lasts as long as this page does
      }
    },
    [projectKey],
  );

  // Fetched every time the list is shown on a session, including on the way
  // back from an issue: this component outlives the issue page (it renders
  // nothing there), so without it a deleted issue would still be listed.
  const shown = open && !!pathname?.startsWith("/sessions/");
  useEffect(() => {
    if (shown) load();
  }, [shown, load]);

  const handleDrop = useCallback(
    async (activeKey: string, targetStatus: string, targetIndex: number) => {
      const stale = dropGuard.begin();
      const previous = issues;
      const { placement, optimistic } = resolveIssueDrop(issues, activeKey, targetStatus, targetIndex);
      setMoveError(null);
      setIssues(optimistic);
      try {
        const changed = await sendIssuePlacement(placement as IssuePlacement);
        if (stale()) return;
        setIssues((list) => mergeIssueChanges(list, changed));
      } catch (err) {
        if (stale()) return;
        setIssues(previous);
        setMoveError(err instanceof Error ? err.message : "Failed to move the issue");
      }
    },
    [dropGuard, issues],
  );

  const router = useRouter();
  // Closing the list and handing the key to the composer through the URL:
  // InputArea picks `insert` up, appends it to the draft and clears the param.
  const insertIssue = useCallback(
    (issue: Issue) => {
      setOpen(false);
      setNewOpen(false);
      const params = new URLSearchParams(window.location.search);
      params.delete("issues");
      params.set("insert", issue.key);
      const query = params.toString();
      router.replace(`${window.location.pathname}${query ? `?${query}` : ""}`, { scroll: false });
    },
    [router],
  );
  const selected = projects.find((p) => p.id === projectId);
  const visible = useMemo(() => (projectId ? issues.filter((issue) => issue.projectId === projectId) : issues), [issues, projectId]);
  const groups = useMemo(
    () =>
      groupIssuesByStatus(visible, {
        includeEmpty: true,
        ...(selected ? { statuses: resolveProjectStatuses(selected).map((s) => s.name) } : {}),
      }),
    [visible, selected],
  );
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  // A session page and nothing else: the shell's cwd is set once by the session
  // page and never cleared, so anything else would offer the last session's
  // repository.
  if (!loaded || !settings.issuesEnabled || !cwd || !pathname?.startsWith("/sessions/")) return null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0"
        onClick={() => setOpenInUrl(true)}
        title="Issues for this project"
        data-testid="session-issues"
      >
        <ClipboardList className="h-4 w-4" />
      </Button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-3 sm:p-6"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setOpenInUrl(false);
            }}
          >
            <div
              className="flex h-[min(85vh,44rem)] max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border bg-background shadow-lg"
              data-testid="session-issues-modal"
            >
              <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
                <ClipboardList className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">Issues</h2>
                <select
                  value={projectId ?? ""}
                  onChange={(e) => chooseProject(e.target.value)}
                  data-testid="session-issues-project"
                  className="ml-2 rounded-md border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">All projects</option>
                  {projects
                    .filter((p) => !p.archived)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
                <button
                  onClick={() => setNewOpen(true)}
                  className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="New issue"
                  title="New issue"
                  data-testid="session-issues-new"
                >
                  <Plus className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setOpenInUrl(false)}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="session-issues-list">
                {moveError && (
                  <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {moveError}
                  </div>
                )}
                {loading ? (
                  <div className="flex h-full items-center justify-center" data-testid="session-issues-loading">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : groups.length === 0 ? (
                  <p className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
                    No issues in this project.
                  </p>
                ) : (
                  <IssueList
                    issues={visible}
                    statusGroups={groups}
                    project={selected}
                    projectNames={projectNames}
                    onIssueClick={(issue) => {
                      // Carry where we are — the URL still says ?issues=1, so
                      // closing or deleting the issue comes back to this session
                      // with the list reopened, not to the bare session.
                      const from = encodeURIComponent(window.location.pathname + window.location.search);
                      const path = `/issues/${encodeURIComponent(issue.key)}?from=${from}`;
                      // Over the session, in the same page-modal as the
                      // sidebar's pages, so closing the issue lands back on
                      // this list rather than replacing the session.
                      if (!openPageModal(path)) router.push(path);
                    }}
                    onDrop={handleDrop}
                    copyable
                    onInsert={insertIssue}
                    collapsible
                    collapsedGroups={collapsedGroups ?? EMPTY_STATUS_SET}
                    onToggleGroup={toggleGroup}
                    className={cn("pb-2")}
                  />
                )}
              </div>
            </div>
          </div>
          <NewIssueDialog
            open={newOpen}
            onOpenChange={setNewOpen}
            projects={projects}
            defaultProjectId={projectId || matched?.id || ""}
            onCreated={(issue) => {
              setIssues((prev) => [...prev, issue]);
              // Show the list the issue landed in, so creating one never sends
              // the user out of the modal to find it.
              chooseProject(issue.projectId);
            }}
          />
        </>
      )}
    </>
  );
}
