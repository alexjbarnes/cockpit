"use client";

import { ClipboardList, Loader2, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import { filterIssues, groupIssuesByStatus, ISSUE_STATUSES, priorityLabel } from "@/lib/issue-display";
import type { Issue, IssueStatus, Project } from "@/types";

const SELECT_CLASS = "rounded-md border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
// This was a fourth hand-written copy of the nine status strings until now —
// found while consolidating the other three onto @/types's canonical
// ISSUE_STATUSES (see that file's comment). "" up front is this dropdown's
// own "all statuses" option, not part of the canonical list.
const ALL_STATUSES: (IssueStatus | "")[] = ["", ...ISSUE_STATUSES];

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

  const [issues, setIssues] = useState<Issue[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectFilter, setProjectFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<IssueStatus | "">("");
  const [newOpen, setNewOpen] = useState(false);

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

  const groups = useMemo(() => {
    const filtered = filterIssues(issues, {
      projectId: projectFilter || undefined,
      status: statusFilter || undefined,
    });
    return groupIssuesByStatus(filtered);
  }, [issues, projectFilter, statusFilter]);

  const hasFilters = projectFilter !== "" || statusFilter !== "";

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 pb-24 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} className={SELECT_CLASS}>
          <option value="">All Projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as IssueStatus | "")} className={SELECT_CLASS}>
          {ALL_STATUSES.map((s) => (
            <option key={s || "all"} value={s}>
              {s || "All Statuses"}
            </option>
          ))}
        </select>
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

      {!loading && issues.length > 0 && groups.length === 0 && (
        <p className="text-sm text-muted-foreground py-8 text-center">No issues match these filters.</p>
      )}

      <div className="space-y-4">
        {groups.map((group) => (
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
