"use client";

import { ChevronRight, ClipboardList, Loader2, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import { useSettings } from "@/hooks/use-settings";
import type { IssueProjectGroup, QuickFilter } from "@/lib/issue-display";
import {
  filterByQuickFilter,
  filterIssues,
  groupIssuesByProject,
  groupIssuesByStatus,
  ISSUE_STATUSES,
  labelColor,
  NO_LABEL_GROUP,
  priorityLabel,
} from "@/lib/issue-display";
import { cn } from "@/lib/utils";
import type { Issue, IssueStatus, Project } from "@/types";

const SELECT_CLASS = "rounded-md border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
// This was a fourth hand-written copy of the nine status strings until now —
// found while consolidating the other three onto @/types's canonical
// ISSUE_STATUSES (see that file's comment). "" up front is this dropdown's
// own "all statuses" option, not part of the canonical list.
const ALL_STATUSES: (IssueStatus | "")[] = ["", ...ISSUE_STATUSES];

const QUICK_FILTERS: { value: QuickFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "backlog", label: "Backlog" },
  { value: "all", label: "All issues" },
];

// "By status"/"By project" and per-project collapse state, mirroring the
// get/save-a-JSON-map-under-one-key convention SidebarSection already uses
// for its own per-section collapse state (src/components/sidebar-section.tsx)
// — same shape, separate storage key since these are unrelated collapse
// namespaces (nav sections vs. issue project groups).
const VIEW_KEY = "cockpit_issues_view";
const PROJECT_OPEN_KEY = "cockpit_issues_projects_open";

function getProjectOpen(id: string): boolean {
  try {
    const raw = localStorage.getItem(PROJECT_OPEN_KEY);
    if (raw) {
      const map = JSON.parse(raw);
      if (id in map) return map[id];
    }
  } catch {}
  return true;
}

function saveProjectOpen(id: string, open: boolean): void {
  try {
    const raw = localStorage.getItem(PROJECT_OPEN_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[id] = open;
    localStorage.setItem(PROJECT_OPEN_KEY, JSON.stringify(map));
  } catch {}
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function IssueRow({ issue, projectName, onClick }: { issue: Issue; projectName: string | undefined; onClick: () => void }) {
  const priority = priorityLabel(issue.priority);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="flex items-center gap-3 px-4 py-3 border-b last:border-b-0 hover:bg-accent/50 transition-colors cursor-pointer"
    >
      <span className="font-mono text-xs text-muted-foreground shrink-0">{issue.key}</span>
      <div className="flex-1 min-w-0">
        <div className="truncate text-sm font-medium">{issue.title}</div>
        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
          {projectName && <span>{projectName}</span>}
          {priority !== "No priority" && <span>{priority}</span>}
          {issue.labels && issue.labels.length > 0 && <span>{issue.labels.join(", ")}</span>}
          <span>{timeAgo(issue.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
}

/** Shared collapsible row for a project group or a label sub-group: chevron
 *  + optional colour dot + name + count. Left padding (indent) and the
 *  name's font weight are caller-supplied via className/labelClassName so
 *  the two nesting levels can read as a visual hierarchy. */
function GroupHeader({
  open,
  onToggle,
  label,
  count,
  dot,
  className,
  labelClassName,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  count: number;
  dot?: React.ReactNode;
  className?: string;
  labelClassName?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn("flex w-full items-center gap-2 py-3 pr-4 text-left hover:bg-accent/50 transition-colors min-w-0", className)}
    >
      <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      {dot}
      <span className={cn("flex-1 min-w-0 truncate text-sm", labelClassName)}>{label}</span>
      <Badge variant="secondary">{count}</Badge>
    </button>
  );
}

// Deliberately leaner than IssueRow: project + label are already implied by
// where this row sits, so repeating project/priority/labels here would just
// be noise. Matches the reference screenshot: truncated title, small status
// indicator, nothing else.
function ProjectViewIssueRow({ issue, onClick }: { issue: Issue; onClick: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="flex items-center gap-2 pl-14 pr-4 py-2.5 border-b last:border-b-0 hover:bg-accent/50 transition-colors cursor-pointer"
    >
      <span className="flex-1 min-w-0 truncate text-sm">{issue.title}</span>
      <span className="shrink-0 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground">{issue.status}</span>
    </div>
  );
}

/** One collapsible project group in the "By project" view: a header row
 *  (name + total count, persisted open/closed via getProjectOpen/
 *  saveProjectOpen) holding its label sub-groups, each independently
 *  collapsible (not persisted — only per-project state was asked for). */
function ProjectGroupCard({ group, onIssueClick }: { group: IssueProjectGroup; onIssueClick: (issue: Issue) => void }) {
  const [open, setOpen] = useState(true);
  const [collapsedLabels, setCollapsedLabels] = useState<Set<string>>(new Set());

  useEffect(() => {
    setOpen(getProjectOpen(group.project.id));
  }, [group.project.id]);

  const toggleProject = () => {
    const next = !open;
    setOpen(next);
    saveProjectOpen(group.project.id, next);
  };

  const toggleLabel = (label: string) => {
    setCollapsedLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  return (
    <Card className="py-0 overflow-hidden">
      <CardContent className="p-0">
        <GroupHeader
          open={open}
          onToggle={toggleProject}
          label={group.project.name}
          count={group.issues.length}
          className="pl-4"
          labelClassName="font-semibold"
        />
        {open &&
          group.labelGroups.map((lg) => {
            const labelOpen = !collapsedLabels.has(lg.label);
            return (
              <div key={lg.label} className="border-t">
                <GroupHeader
                  open={labelOpen}
                  onToggle={() => toggleLabel(lg.label)}
                  label={lg.label}
                  count={lg.issues.length}
                  className="pl-8 py-2.5"
                  labelClassName="font-medium"
                  dot={
                    <span
                      className={cn(
                        "h-2.5 w-2.5 rounded-full shrink-0",
                        lg.label === NO_LABEL_GROUP ? "bg-muted-foreground/30" : labelColor(lg.label),
                      )}
                    />
                  }
                />
                {labelOpen &&
                  lg.issues.map((issue) => <ProjectViewIssueRow key={issue.id} issue={issue} onClick={() => onIssueClick(issue)} />)}
              </div>
            );
          })}
      </CardContent>
    </Card>
  );
}

function NewIssueDialog({
  open,
  onOpenChange,
  projects,
  defaultProjectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  defaultProjectId: string;
  onCreated: (issue: Issue) => void;
}) {
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setProjectId(defaultProjectId || projects[0]?.id || "");
      setTitle("");
      setDescription("");
      setError(null);
    }
  }, [open, defaultProjectId, projects]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId || !title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title: title.trim(), description: description.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create issue");
        return;
      }
      onCreated(data.issue);
      onOpenChange(false);
    } catch {
      setError("Failed to connect");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)}>
        <DialogHeader>
          <DialogTitle>New Issue</DialogTitle>
        </DialogHeader>
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground mt-2">Create a project first, in Settings &gt; Projects.</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3 mt-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Project</label>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={`w-full ${SELECT_CLASS}`}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.prefix})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Title</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" required autoFocus />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Description (optional)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Markdown supported"
                className="w-full min-h-[100px] rounded-md border bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !title.trim()}>
                {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                Create
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function IssuesPage() {
  usePageHeader("Issues", { hideActions: true });
  const scrollRef = useScrollRestoration<HTMLDivElement>("issues-scroll");
  const router = useRouter();
  const { settings, loaded: settingsLoaded } = useSettings();

  const [issues, setIssues] = useState<Issue[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectFilter, setProjectFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<IssueStatus | "">("");
  const [newOpen, setNewOpen] = useState(false);
  const [view, setView] = useState<"status" | "project">("status");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");

  useEffect(() => {
    const stored = localStorage.getItem(VIEW_KEY);
    if (stored === "status" || stored === "project") setView(stored);
  }, []);

  // Experimental and off by default (see defaults.ts's issuesEnabled) — a
  // stale bookmark or typed URL must not land on a working page. Gated on
  // settingsLoaded first: redirecting on the pre-fetch default (false) would
  // bounce a user who actually has it enabled, since useSettings starts at
  // its own default before /api/defaults resolves.
  useEffect(() => {
    if (settingsLoaded && !settings.issuesEnabled) router.replace("/");
  }, [settingsLoaded, settings.issuesEnabled, router]);

  const changeView = useCallback((next: "status" | "project") => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {}
  }, []);

  const fetchAll = useCallback(async () => {
    const [issuesRes, projectsRes] = await Promise.all([fetch("/api/issues"), fetch("/api/projects")]);
    if (issuesRes.ok) {
      const data = await issuesRes.json();
      setIssues(data.issues || []);
    }
    if (projectsRes.ok) {
      const data = await projectsRes.json();
      setProjects(data.projects || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  // The status dropdown only renders (and only applies) in the status view —
  // the project view replaces it with the quick filter pills, so its stale
  // value must not silently narrow the project view once the user switches.
  const filtered = useMemo(() => {
    const byDropdowns = filterIssues(issues, {
      projectId: projectFilter || undefined,
      status: view === "status" ? statusFilter || undefined : undefined,
    });
    return filterByQuickFilter(byDropdowns, quickFilter);
  }, [issues, projectFilter, statusFilter, quickFilter, view]);

  const statusGroups = useMemo(() => groupIssuesByStatus(filtered), [filtered]);
  const projectGroups = useMemo(() => groupIssuesByProject(filtered, projects), [filtered, projects]);

  const hasFilters = projectFilter !== "" || (view === "status" && statusFilter !== "");

  if (!settingsLoaded || !settings.issuesEnabled) return null;

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 pb-24 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex shrink-0 gap-0.5 rounded-md border p-0.5">
          {(["status", "project"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => changeView(v)}
              aria-pressed={view === v}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                view === v ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v === "status" ? "By status" : "By project"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {QUICK_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setQuickFilter(f.value)}
              aria-pressed={quickFilter === f.value}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                quickFilter === f.value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} className={SELECT_CLASS}>
          <option value="">All Projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {view === "status" && (
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as IssueStatus | "")} className={SELECT_CLASS}>
            {ALL_STATUSES.map((s) => (
              <option key={s || "all"} value={s}>
                {s || "All Statuses"}
              </option>
            ))}
          </select>
        )}
        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              setProjectFilter("");
              setStatusFilter("");
            }}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3 w-3" />
            Clear filters
          </button>
        )}
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading issues...</p>}

      {!loading && issues.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <ClipboardList className="h-12 w-12 text-muted-foreground/50 mb-4" />
          <p className="text-sm text-muted-foreground">No issues yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            {projects.length === 0 ? "Create a project first, in Settings > Projects." : "Create one to start tracking work."}
          </p>
        </div>
      )}

      {!loading && issues.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground py-8 text-center">No issues match these filters.</p>
      )}

      {view === "status" ? (
        <div className="space-y-4">
          {statusGroups.map((group) => (
            <div key={group.status}>
              <div className="flex items-center gap-2 mb-1.5 px-1">
                <h2 className="text-sm font-semibold">{group.status}</h2>
                <Badge variant="secondary">{group.issues.length}</Badge>
              </div>
              <Card className="py-0 overflow-hidden">
                <CardContent className="p-0">
                  {group.issues.map((issue) => (
                    <IssueRow
                      key={issue.id}
                      issue={issue}
                      projectName={projectNames.get(issue.projectId)}
                      onClick={() => router.push(`/issues/${encodeURIComponent(issue.key)}`)}
                    />
                  ))}
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {projectGroups.map((group) => (
            <ProjectGroupCard
              key={group.project.id}
              group={group}
              onIssueClick={(issue) => router.push(`/issues/${encodeURIComponent(issue.key)}`)}
            />
          ))}
        </div>
      )}

      <div className="fixed bottom-6 right-6">
        <Button size="lg" className="rounded-full shadow-lg" onClick={() => setNewOpen(true)}>
          <Plus className="h-5 w-5 mr-1" />
          New Issue
        </Button>
      </div>

      <NewIssueDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        projects={projects}
        defaultProjectId={projectFilter}
        onCreated={(issue) => {
          setIssues((prev) => [...prev, issue]);
          router.push(`/issues/${encodeURIComponent(issue.key)}`);
        }}
      />
    </div>
  );
}
