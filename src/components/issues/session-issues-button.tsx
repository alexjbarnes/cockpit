"use client";

import { ClipboardList, Loader2, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "@/components/app-shell";
import { IssueList } from "@/components/issues/issue-list";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/hooks/use-settings";
import { groupIssuesByStatus, type IssuePlacement, projectForCwd, resolveProjectStatuses } from "@/lib/issue-display";
import { mergeIssueChanges, resolveIssueDrop, sendIssuePlacement } from "@/lib/issue-drag";
import { createStaleGuard } from "@/lib/stale-guard";
import { cn } from "@/lib/utils";
import type { Issue, Project } from "@/types";

/**
 * The session header's way into its project's issues: the ones belonging to the
 * repository this session is working in, over the top of the session, draggable
 * the same way the Issues page is. The project is a picker rather than a
 * fixed lookup — a project may have no repo path set, or the session may be
 * outside every repo, and neither should leave the button dead.
 */
export function SessionIssuesButton() {
  const { cwd } = useShell();
  const pathname = usePathname();
  const { settings, loaded, reload } = useSettings();
  const [open, setOpen] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const dropGuard = useRef(createStaleGuard()).current;

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
      const issuesData = issuesRes.ok ? ((await issuesRes.json()) as { issues: Issue[] }) : { issues: [] };
      const projectsData = projectsRes.ok ? ((await projectsRes.json()) as { projects: Project[] }) : { projects: [] };
      setIssues(issuesData.issues ?? []);
      setProjects(projectsData.projects ?? []);
      setProjectId((current) => current || projectForCwd(projectsData.projects ?? [], cwd)?.id || "");
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

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
        className="shrink-0 h-8 w-8 text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
        title="Issues for this project"
        data-testid="session-issues"
      >
        <ClipboardList className="h-4 w-4" />
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-3 sm:p-6"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border bg-background shadow-lg"
            data-testid="session-issues-modal"
          >
            <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
              <ClipboardList className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Issues</h2>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
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
              {matched && projectId === matched.id && (
                <span className="truncate text-xs text-muted-foreground">from this session's directory</span>
              )}
              <button
                onClick={() => setOpen(false)}
                className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {moveError && (
                <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {moveError}
                </div>
              )}
              {loading ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : groups.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">No issues in this project.</p>
              ) : (
                <IssueList
                  issues={visible}
                  statusGroups={groups}
                  project={selected}
                  projectNames={projectNames}
                  onIssueClick={(issue) => {
                    setOpen(false);
                    router.push(`/issues/${encodeURIComponent(issue.key)}`);
                  }}
                  onDrop={handleDrop}
                  className={cn("pb-2")}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
