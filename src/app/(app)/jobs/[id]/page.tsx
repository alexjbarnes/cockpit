"use client";

import { ArrowLeft, Loader2, Pencil, Play, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useJobRuns } from "@/hooks/use-jobs";
import { findModelById } from "@/lib/models";
import { describeAllSchedules, getJobSchedules } from "@/server/cron-utils";
import type { ScheduledJob } from "@/types";

function runStatusBadge(status: string) {
  switch (status) {
    case "success":
      return <Badge className="bg-green-600 text-white">Success</Badge>;
    case "failure":
      return <Badge variant="destructive">Failed</Badge>;
    case "timeout":
      return <Badge className="bg-yellow-600 text-white">Timeout</Badge>;
    case "running":
      return <Badge className="bg-blue-600 text-white">Running</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function formatModel(job: ScheduledJob): string {
  const raw = job.model || "";
  const base = raw.replace(/\[.*\]$/, "");
  const entry = findModelById(base);
  if (!entry) return raw || "Default";
  const label = entry.alias.charAt(0).toUpperCase() + entry.alias.slice(1);
  const ext = /\[1m\]$/i.test(raw) ? " (1M)" : "";
  return `${label} ${entry.version}${ext}`;
}

export default function JobDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();

  const [job, setJob] = useState<ScheduledJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  usePageHeader(job?.name || "Job");

  const { runs, loading: runsLoading, loadingMore, hasMore, refresh: refreshRuns, loadMore } = useJobRuns(id);

  const loadJob = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${id}`);
      if (!res.ok) {
        router.push("/jobs");
        return;
      }
      const data = await res.json();
      setJob(data.job);
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    loadJob();
  }, [loadJob]);

  async function handleTrigger() {
    setTriggering(true);
    await fetch(`/api/jobs/${id}/trigger`, { method: "POST" });
    setTriggering(false);
    refreshRuns();
  }

  async function handleDelete() {
    const res = await fetch(`/api/jobs/${id}`, { method: "DELETE" });
    if (res.ok) router.push("/jobs");
  }

  if (loading || !job) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto space-y-4 pb-8">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => router.push("/jobs")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold truncate">{job.name}</h2>
              {job.enabled ? <Badge variant="default">Active</Badge> : <Badge variant="secondary">Disabled</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">{describeAllSchedules(getJobSchedules(job))}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => router.push(`/jobs/${id}/edit`)}>
            <Pencil className="h-4 w-4 mr-1" />
            Edit
          </Button>
          <Button variant="outline" size="sm" onClick={handleTrigger} disabled={triggering}>
            {triggering ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Play className="h-4 w-4 mr-1" />}
            Run Now
          </Button>
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="h-4 w-4 mr-1" />
            Delete
          </Button>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Prompt</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-sm whitespace-pre-wrap break-all font-mono bg-muted rounded p-3">{job.prompt}</pre>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="grid grid-cols-2 gap-y-2 text-sm">
              <span className="text-muted-foreground">Model</span>
              <span className="text-right">{formatModel(job)}</span>
              {job.thinkingLevel && (
                <>
                  <span className="text-muted-foreground">Thinking</span>
                  <span className="text-right capitalize">{job.thinkingLevel}</span>
                </>
              )}
              <span className="text-muted-foreground">Max Duration</span>
              <span className="text-right">{job.maxDurationMinutes ?? 30} min</span>
              {job.cwd && (
                <>
                  <span className="text-muted-foreground">Directory</span>
                  <span className="text-right font-mono text-xs truncate">{job.cwd}</span>
                </>
              )}
              <span className="text-muted-foreground">Permissions</span>
              <span className="text-right">
                {job.bypassPermissions ? "Bypass all" : `${(job.allowedTools || []).length} tools allowed`}
              </span>
              {(job.mcpServers || []).length > 0 && (
                <>
                  <span className="text-muted-foreground">MCP Servers</span>
                  <span className="text-right text-xs font-mono truncate">{(job.mcpServers || []).join(", ")}</span>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Run History</CardTitle>
          </CardHeader>
          <CardContent>
            {runsLoading && <p className="text-sm text-muted-foreground">Loading runs...</p>}
            {!runsLoading && runs.length === 0 && <p className="text-sm text-muted-foreground">No runs yet.</p>}
            <div className="space-y-1">
              {runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className="w-full flex items-center gap-3 rounded px-2 py-2 hover:bg-muted transition-colors text-left"
                  onClick={() => router.push(`/jobs/${id}/runs/${run.id}`)}
                >
                  {runStatusBadge(run.status)}
                  <span className="text-xs text-muted-foreground flex-1">{new Date(run.startedAt).toLocaleString()}</span>
                  {run.durationMs != null && <span className="text-xs text-muted-foreground">{Math.round(run.durationMs / 1000)}s</span>}
                </button>
              ))}
            </div>
            {hasMore && (
              <Button variant="ghost" size="sm" className="w-full mt-2" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading..." : "Load more"}
              </Button>
            )}
          </CardContent>
        </Card>

        <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Job</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground mb-4">Delete this job and all run history? This cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleDelete}>
                Delete
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
