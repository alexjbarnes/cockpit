"use client";

import { AlertCircle, CalendarClock, CheckCircle2, ChevronRight, Copy, Folder, Loader2, Play, Plus, Square, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useJobs } from "@/hooks/use-jobs";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import { type JobDisplayStatus, jobDisplayStatus } from "@/lib/job-display";
import { describeAllSchedules, getJobSchedules, getNextRunTimeAny } from "@/server/cron-utils";
import type { ScheduledJob } from "@/types";

type JobWithStatus = ScheduledJob & {
  lastRunStatus?: string;
  lastRunAt?: number;
  lastRunError?: string;
};

function statusBadge(status: JobDisplayStatus) {
  if (status === "running") return <Badge variant="default">Running</Badge>;
  if (status === "disabled") return <Badge variant="secondary">Disabled</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (status === "stopped") return <Badge variant="secondary">Stopped</Badge>;
  return <Badge variant="default">Enabled</Badge>;
}

function lastRunInfo(job: JobWithStatus) {
  if (!job.lastRunAt) return null;
  const ago = timeAgo(job.lastRunAt);
  if (job.lastRunStatus === "failure" || job.lastRunStatus === "timeout") {
    return (
      <span className="flex items-center gap-1 text-destructive">
        <AlertCircle className="h-3 w-3" />
        Failed {ago}
      </span>
    );
  }
  if (job.lastRunStatus === "success") {
    return (
      <span className="flex items-center gap-1 text-green-500">
        <CheckCircle2 className="h-3 w-3" />
        Succeeded {ago}
      </span>
    );
  }
  if (job.lastRunStatus === "stopped") {
    return <span className="flex items-center gap-1 text-muted-foreground">Stopped {ago}</span>;
  }
  return null;
}

function runningIndicator() {
  return (
    <span className="flex items-center gap-1">
      <Loader2 className="h-3 w-3 animate-spin" />
      Running
    </span>
  );
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

function formatNextRun(job: JobWithStatus): string {
  if (!job.enabled) return "Disabled";
  try {
    const next = getNextRunTimeAny(getJobSchedules(job), new Date());
    return next.toLocaleString();
  } catch {
    return "Unknown";
  }
}

function dirName(cwd: string): string {
  if (!cwd) return "Scratchpad";
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

interface JobGroupData {
  cwd: string;
  dirName: string;
  jobs: JobWithStatus[];
}

function groupJobsByDir(jobs: JobWithStatus[]): JobGroupData[] {
  const map = new Map<string, JobWithStatus[]>();
  for (const job of jobs) {
    const cwd = job.cwd || "";
    const group = map.get(cwd) || [];
    group.push(job);
    map.set(cwd, group);
  }
  const groups: JobGroupData[] = [];
  for (const [cwd, groupJobs] of map) {
    groups.push({ cwd, dirName: dirName(cwd), jobs: groupJobs });
  }
  groups.sort((a, b) => {
    if (!a.cwd) return -1;
    if (!b.cwd) return 1;
    return a.dirName.localeCompare(b.dirName);
  });
  return groups;
}

function JobCard({
  job,
  triggeringJobs,
  stoppingJobs,
  onTrigger,
  onStop,
  onDuplicate,
  onDelete,
  onClick,
}: {
  job: JobWithStatus;
  triggeringJobs: Set<string>;
  stoppingJobs?: Set<string>;
  onTrigger: (e: React.MouseEvent, id: string) => void;
  onStop?: (e: React.MouseEvent, id: string) => void;
  onDuplicate: (e: React.MouseEvent, id: string) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  onClick: (id: string) => void;
}) {
  const status = jobDisplayStatus(job, triggeringJobs.has(job.id));
  const running = status === "running";
  return (
    <Card className="cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => onClick(job.id)}>
      <CardContent className="p-4">
        {/* Row 1: title spans the full card width; status badge trails at the right */}
        <div className="flex items-center gap-2 mb-2">
          <span className="font-medium text-sm truncate flex-1 min-w-0">{job.name}</span>
          {statusBadge(status)}
        </div>
        {/* Row 2: schedule/next/last-run metadata on the left, actions on the right */}
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground">{describeAllSchedules(getJobSchedules(job))}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Next: {formatNextRun(job)}</p>
            {running ? (
              <p className="text-xs mt-0.5">{runningIndicator()}</p>
            ) : (
              lastRunInfo(job) && <p className="text-xs mt-0.5">{lastRunInfo(job)}</p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {status === "running" && onStop && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                title="Stop now"
                disabled={stoppingJobs?.has(job.id)}
                onClick={(e) => onStop(e, job.id)}
              >
                {stoppingJobs?.has(job.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title="Run now"
              disabled={triggeringJobs.has(job.id)}
              onClick={(e) => onTrigger(e, job.id)}
            >
              {triggeringJobs.has(job.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" title="Duplicate" onClick={(e) => onDuplicate(e, job.id)}>
              <Copy className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:text-destructive"
              title="Delete"
              onClick={(e) => onDelete(e, job.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function JobDirGroup({
  group,
  triggeringJobs,
  stoppingJobs,
  onTrigger,
  onStop,
  onDuplicate,
  onDelete,
  onClickJob,
  onCreateJob,
  defaultExpanded,
}: {
  group: JobGroupData;
  triggeringJobs: Set<string>;
  stoppingJobs?: Set<string>;
  onTrigger: (e: React.MouseEvent, id: string) => void;
  onStop?: (e: React.MouseEvent, id: string) => void;
  onDuplicate: (e: React.MouseEvent, id: string) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  onClickJob: (id: string) => void;
  onCreateJob: (cwd: string) => void;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const failedCount = group.jobs.filter((j) => j.lastRunStatus === "failure" || j.lastRunStatus === "timeout").length;

  return (
    <div className="rounded-lg border bg-card">
      <div
        role="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 p-3 text-left hover:bg-accent/50 rounded-lg transition-colors cursor-pointer"
      >
        <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="font-medium text-sm truncate flex-1">{group.dirName}</span>
        <div className="flex items-center gap-2 shrink-0">
          {failedCount > 0 && <Badge variant="destructive">{failedCount} failed</Badge>}
          <span className="text-xs text-muted-foreground">
            {group.jobs.length} job{group.jobs.length !== 1 ? "s" : ""}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCreateJob(group.cwd);
            }}
            className="p-1 rounded hover:bg-accent"
            title="New job in this folder"
          >
            <Plus className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {group.jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              triggeringJobs={triggeringJobs}
              stoppingJobs={stoppingJobs}
              onTrigger={onTrigger}
              onStop={onStop}
              onDuplicate={onDuplicate}
              onDelete={onDelete}
              onClick={onClickJob}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function JobsPage() {
  usePageHeader("Scheduled Jobs", { hideActions: true });
  const scrollRef = useScrollRestoration<HTMLDivElement>("jobs-scroll");

  const { jobs, loading, deleteJob, triggerJob, stopJob, refresh } = useJobs();
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [triggeringJobs, setTriggeringJobs] = useState<Set<string>>(new Set());
  const [stoppingJobs, setStoppingJobs] = useState<Set<string>>(new Set());

  const groups = useMemo(() => groupJobsByDir(jobs as JobWithStatus[]), [jobs]);

  async function handleDelete() {
    if (!confirmDelete) return;
    await deleteJob(confirmDelete);
    setConfirmDelete(null);
  }

  async function handleTrigger(e: React.MouseEvent, jobId: string) {
    e.stopPropagation();
    setTriggeringJobs((prev) => new Set(prev).add(jobId));
    await triggerJob(jobId);
    setTriggeringJobs((prev) => {
      const next = new Set(prev);
      next.delete(jobId);
      return next;
    });
    refresh();
  }

  async function handleStopClick(e: React.MouseEvent, jobId: string) {
    e.stopPropagation();
    setStoppingJobs((prev) => new Set(prev).add(jobId));
    setTriggeringJobs((prev) => {
      const next = new Set(prev);
      next.delete(jobId);
      return next;
    });
    await stopJob(jobId);
    setStoppingJobs((prev) => {
      const next = new Set(prev);
      next.delete(jobId);
      return next;
    });
    refresh();
  }

  function handleDuplicate(e: React.MouseEvent, jobId: string) {
    e.stopPropagation();
    router.push(`/jobs/new/edit?from=${jobId}`);
  }

  function handleDeleteClick(e: React.MouseEvent, jobId: string) {
    e.stopPropagation();
    setConfirmDelete(jobId);
  }

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 pb-24 space-y-4">
      {loading && <p className="text-sm text-muted-foreground">Loading jobs...</p>}

      {!loading && jobs.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <CalendarClock className="h-12 w-12 text-muted-foreground/50 mb-4" />
          <p className="text-sm text-muted-foreground">No scheduled jobs yet.</p>
          <p className="text-xs text-muted-foreground mt-1">Create one to run Claude on a schedule.</p>
        </div>
      )}

      <div className="space-y-2">
        {groups.length === 1
          ? groups[0].jobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                triggeringJobs={triggeringJobs}
                stoppingJobs={stoppingJobs}
                onTrigger={handleTrigger}
                onStop={handleStopClick}
                onDuplicate={handleDuplicate}
                onDelete={handleDeleteClick}
                onClick={(id) => router.push(`/jobs/${id}`)}
              />
            ))
          : groups.map((group) => (
              <JobDirGroup
                key={group.cwd}
                group={group}
                triggeringJobs={triggeringJobs}
                stoppingJobs={stoppingJobs}
                onTrigger={handleTrigger}
                onStop={handleStopClick}
                onDuplicate={handleDuplicate}
                onDelete={handleDeleteClick}
                onClickJob={(id) => router.push(`/jobs/${id}`)}
                onCreateJob={(cwd) => router.push(`/jobs/new/edit?cwd=${encodeURIComponent(cwd)}`)}
                defaultExpanded={groups.length <= 3}
              />
            ))}
      </div>

      <div className="fixed bottom-6 right-6">
        <Button size="lg" className="rounded-full shadow-lg" onClick={() => router.push("/jobs/new/edit")}>
          <Plus className="h-5 w-5 mr-1" />
          New Job
        </Button>
      </div>

      <Dialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Job</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">Delete this job and all its run history? This cannot be undone.</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
