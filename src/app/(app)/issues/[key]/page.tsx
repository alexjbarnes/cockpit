"use client";

import { ArrowLeft, Loader2, Paperclip, Pencil, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { MarkdownRender } from "@/components/markdown-render";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSettings } from "@/hooks/use-settings";
import { actorHref, actorLabel, describeActivityAction, ISSUE_STATUSES } from "@/lib/issue-display";
import type { Issue, IssueActor, IssueStatus, Project } from "@/types";

const SELECT_CLASS = "rounded-md border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

/** The actor's name, as a link to its session transcript or job page when it
 *  has one (session/job), plain text otherwise (user, assistant). */
function ActorName({ actor, className }: { actor: IssueActor; className?: string }) {
  const href = actorHref(actor);
  const label = actorLabel(actor);
  if (!href) return <span className={className}>{label}</span>;
  return (
    <Link href={href} className={`${className ?? ""} underline-offset-2 hover:underline`.trim()}>
      {label}
    </Link>
  );
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

async function patchIssue(key: string, patch: Record<string, unknown>): Promise<{ ok: true; issue: Issue } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/issues/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || "Failed to save" };
    return { ok: true, issue: data.issue };
  } catch {
    return { ok: false, error: "Failed to connect" };
  }
}

export default function IssueDetailPage() {
  const { key } = useParams<{ key: string }>();
  const router = useRouter();
  usePageHeader("Issue", { hideActions: true });
  const { settings, loaded: settingsLoaded } = useSettings();

  const [issue, setIssue] = useState<Issue | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [savingDetails, setSavingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const [savingStatus, setSavingStatus] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [savingPriority, setSavingPriority] = useState(false);
  const [priorityError, setPriorityError] = useState<string | null>(null);

  const [labelInput, setLabelInput] = useState("");
  const [savingLabels, setSavingLabels] = useState(false);
  const [labelsError, setLabelsError] = useState<string | null>(null);

  const [commentDraft, setCommentDraft] = useState("");
  const [savingComment, setSavingComment] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);

  const fetchIssue = useCallback(async () => {
    const res = await fetch(`/api/issues/${encodeURIComponent(key)}`);
    if (!res.ok) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    const data = await res.json();
    setIssue(data.issue);
    setLoading(false);
  }, [key]);

  useEffect(() => {
    fetchIssue();
  }, [fetchIssue]);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setProjects(d.projects || []))
      .catch(() => {});
  }, []);

  // See issues/page.tsx's identical guard for why this waits on settingsLoaded.
  useEffect(() => {
    if (settingsLoaded && !settings.issuesEnabled) router.replace("/");
  }, [settingsLoaded, settings.issuesEnabled, router]);

  function startEditing() {
    if (!issue) return;
    setTitleDraft(issue.title);
    setDescriptionDraft(issue.description);
    setDetailsError(null);
    setEditing(true);
  }

  async function saveDetails() {
    if (!issue || !titleDraft.trim()) return;
    setSavingDetails(true);
    setDetailsError(null);
    const result = await patchIssue(issue.key, { title: titleDraft.trim(), description: descriptionDraft });
    if (result.ok) {
      setIssue(result.issue);
      setEditing(false);
    } else {
      setDetailsError(result.error);
    }
    setSavingDetails(false);
  }

  async function changeStatus(status: IssueStatus) {
    if (!issue || status === issue.status) return;
    setSavingStatus(true);
    setStatusError(null);
    const result = await patchIssue(issue.key, { status });
    if (result.ok) setIssue(result.issue);
    else setStatusError(result.error);
    setSavingStatus(false);
  }

  async function changePriority(priority: number) {
    if (!issue) return;
    setSavingPriority(true);
    setPriorityError(null);
    const result = await patchIssue(issue.key, { priority });
    if (result.ok) setIssue(result.issue);
    else setPriorityError(result.error);
    setSavingPriority(false);
  }

  async function addLabel() {
    const trimmed = labelInput.trim();
    if (!issue || !trimmed) return;
    const current = issue.labels || [];
    if (current.includes(trimmed)) {
      setLabelInput("");
      return;
    }
    setSavingLabels(true);
    setLabelsError(null);
    const result = await patchIssue(issue.key, { labels: [...current, trimmed] });
    if (result.ok) {
      setIssue(result.issue);
      setLabelInput("");
    } else {
      setLabelsError(result.error);
    }
    setSavingLabels(false);
  }

  async function removeLabel(label: string) {
    if (!issue) return;
    setSavingLabels(true);
    setLabelsError(null);
    const result = await patchIssue(issue.key, { labels: (issue.labels || []).filter((l) => l !== label) });
    if (result.ok) setIssue(result.issue);
    else setLabelsError(result.error);
    setSavingLabels(false);
  }

  async function submitComment() {
    if (!issue || !commentDraft.trim()) return;
    setSavingComment(true);
    setCommentError(null);
    try {
      const res = await fetch(`/api/issues/${encodeURIComponent(issue.key)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: commentDraft.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCommentError(data.error || "Failed to add comment");
        return;
      }
      setIssue(data.issue);
      setCommentDraft("");
    } catch {
      setCommentError("Failed to connect");
    } finally {
      setSavingComment(false);
    }
  }

  async function deleteIssue() {
    if (!issue) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/issues/${encodeURIComponent(issue.key)}`, { method: "DELETE" });
      if (!res.ok) {
        // Staying on the page with the reason beats bouncing to a list that
        // still shows the issue, which is what a silent failure looks like.
        const body = await res.json().catch(() => ({}));
        setDeleteError(body.error || `Delete failed (${res.status})`);
        return;
      }
      router.push("/issues");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  if (!settingsLoaded || loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!settings.issuesEnabled) return null;

  if (notFound || !issue) {
    return (
      <div className="flex-1 p-4">
        <Button variant="ghost" size="sm" onClick={() => router.push("/issues")}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <p className="text-sm text-muted-foreground mt-8 text-center">Issue not found.</p>
      </div>
    );
  }

  const project = projects.find((p) => p.id === issue.projectId);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="max-w-3xl mx-auto space-y-4 pb-8">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => router.push("/issues")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="font-mono text-sm text-muted-foreground">{issue.key}</span>
          {project && <span className="text-sm text-muted-foreground">{project.name}</span>}
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto shrink-0 text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
            title="Delete issue"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-4">
            {!editing ? (
              <div className="flex items-start justify-between gap-2">
                <h1 className="text-lg font-semibold flex-1 min-w-0 break-words">{issue.title}</h1>
                <Button variant="ghost" size="icon" className="shrink-0" onClick={startEditing} title="Edit title & description">
                  <Pencil className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Title</label>
                <Input value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={issue.status}
                disabled={savingStatus}
                onChange={(e) => changeStatus(e.target.value as IssueStatus)}
                className={SELECT_CLASS}
              >
                {ISSUE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <select
                value={issue.priority ?? 0}
                disabled={savingPriority}
                onChange={(e) => changePriority(Number(e.target.value))}
                className={SELECT_CLASS}
              >
                <option value={0}>No priority</option>
                <option value={1}>Urgent</option>
                <option value={2}>High</option>
                <option value={3}>Medium</option>
                <option value={4}>Low</option>
              </select>
            </div>
            {statusError && <p className="text-xs text-destructive">{statusError}</p>}
            {priorityError && <p className="text-xs text-destructive">{priorityError}</p>}

            <div>
              {(issue.labels || []).length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-1.5">
                  {(issue.labels || []).map((label) => (
                    <span key={label} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-primary/10 text-primary">
                      {label}
                      <button type="button" onClick={() => removeLabel(label)} className="hover:text-destructive">
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addLabel();
                    }
                  }}
                  placeholder="Add a label"
                  className="flex-1"
                />
                <Button variant="outline" size="sm" onClick={addLabel} disabled={!labelInput.trim() || savingLabels}>
                  Add
                </Button>
              </div>
              {labelsError && <p className="text-xs text-destructive mt-1">{labelsError}</p>}
            </div>

            {!editing ? (
              <div className="border-t pt-4">
                <MarkdownRender content={issue.description || "*No description.*"} variant="full" />
              </div>
            ) : (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Description</label>
                <textarea
                  value={descriptionDraft}
                  onChange={(e) => setDescriptionDraft(e.target.value)}
                  placeholder="Markdown supported"
                  className="w-full min-h-[160px] rounded-md border bg-background px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            )}
            {detailsError && <p className="text-xs text-destructive">{detailsError}</p>}
            {editing && (
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditing(false)} disabled={savingDetails}>
                  Cancel
                </Button>
                <Button size="sm" onClick={saveDetails} disabled={savingDetails || !titleDraft.trim()}>
                  {savingDetails ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                  Save
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {issue.attachments.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Attachments</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {issue.attachments.map((a) => (
                <a
                  key={a.id}
                  // A local file path (the ui-reviewer's screenshots) is only
                  // reachable through the serving route; a remote url links
                  // directly.
                  href={a.url.startsWith("/") ? `/api/issues/${issue.key}/attachments/${a.id}` : a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-primary hover:underline"
                >
                  <Paperclip className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{a.title}</span>
                </a>
              ))}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Comments ({issue.comments.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {issue.comments.length === 0 && <p className="text-sm text-muted-foreground">No comments yet.</p>}
            {issue.comments.map((c) => (
              <div key={c.id} className="border rounded-md p-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                  <ActorName actor={c.author} className="font-medium text-foreground" />
                  <span>{formatDate(c.createdAt)}</span>
                </div>
                <MarkdownRender content={c.body} variant="lite" />
              </div>
            ))}

            <div className="space-y-2 pt-2 border-t">
              <textarea
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                placeholder="Add a comment (markdown supported)"
                className="w-full min-h-[80px] rounded-md border bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {commentError && <p className="text-xs text-destructive">{commentError}</p>}
              <div className="flex justify-end">
                <Button size="sm" onClick={submitComment} disabled={savingComment || !commentDraft.trim()}>
                  {savingComment ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                  Comment
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Activity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {[...issue.activity].reverse().map((entry) => (
              <div key={entry.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  <ActorName actor={entry.actor} /> {describeActivityAction(entry)}
                </span>
                <span>·</span>
                <span>{formatDate(entry.createdAt)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Dialog open={confirmDelete} onOpenChange={(open) => !deleting && setConfirmDelete(open)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {issue.key}?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              This removes the issue, its comments, its activity trail and its attachments. It cannot be undone, and{" "}
              <span className="font-mono">{issue.key}</span> will not be reused. To retire an issue while keeping the record, set its status
              to Cancelled instead.
            </p>
            {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={deleteIssue} disabled={deleting}>
                {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
