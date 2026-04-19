"use client";

import { CalendarClock, Play, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useJobs } from "@/hooks/use-jobs";
import { describeSchedule, getNextRunTime } from "@/server/cron-utils";
import type { ScheduledJob } from "@/types";

function statusBadge(job: ScheduledJob) {
  if (!job.enabled) return <Badge variant="secondary">Disabled</Badge>;
  return <Badge variant="default">Active</Badge>;
}

function formatNextRun(job: ScheduledJob): string {
  if (!job.enabled) return "Disabled";
  try {
    const next = getNextRunTime(job.schedule, new Date());
    return next.toLocaleString();
  } catch {
    return "Unknown";
  }
}

export default function JobsPage() {
  usePageHeader("Scheduled Jobs");

  const { jobs, loading, deleteJob, triggerJob, refresh } = useJobs();
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function handleDelete() {
    if (!confirmDelete) return;
    await deleteJob(confirmDelete);
    setConfirmDelete(null);
  }

  async function handleTrigger(e: React.MouseEvent, jobId: string) {
    e.stopPropagation();
    await triggerJob(jobId);
    refresh();
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div />
        <Button size="sm" onClick={() => router.push("/jobs/new")}>
          <Plus className="h-4 w-4 mr-1" />
          New Job
        </Button>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading jobs...</p>}

      {!loading && jobs.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <CalendarClock className="h-12 w-12 text-muted-foreground/50 mb-4" />
          <p className="text-sm text-muted-foreground">No scheduled jobs yet.</p>
          <p className="text-xs text-muted-foreground mt-1">Create one to run Claude on a schedule.</p>
        </div>
      )}

      <div className="space-y-2">
        {jobs.map((job) => (
          <Card key={job.id} className="cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => router.push(`/jobs/${job.id}`)}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-sm truncate">{job.name}</span>
                    {statusBadge(job)}
                  </div>
                  <p className="text-xs text-muted-foreground">{describeSchedule(job.schedule)}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Next: {formatNextRun(job)}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="icon" className="h-8 w-8" title="Run now" onClick={(e) => handleTrigger(e, job.id)}>
                    <Play className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDelete(job.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
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
