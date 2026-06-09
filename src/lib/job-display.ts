import type { ScheduledJob } from "@/types";

export type JobDisplayStatus = "running" | "disabled" | "failed" | "enabled";

// lastRunStatus is typed `string | undefined` to match JobWithStatus (page.tsx:16),
// whose lastRunStatus is widened to string by the API enrichment; using JobRunStatus
// here would force a cast at the call site.
// Precedence: running is checked FIRST (a triggering or server-running job reads
// "Running" even if disabled). This INTENTIONALLY differs from the current
// statusBadge, which checks !enabled first.
export function jobDisplayStatus(job: Pick<ScheduledJob, "enabled"> & { lastRunStatus?: string }, isTriggering: boolean): JobDisplayStatus {
  if (isTriggering || job.lastRunStatus === "running") return "running";
  if (!job.enabled) return "disabled";
  if (job.lastRunStatus === "failure" || job.lastRunStatus === "timeout") return "failed";
  return "enabled";
}
