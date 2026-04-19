"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { JobRun, ScheduledJob } from "@/types";

export function useJobs() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    fetch("/api/jobs")
      .then((res) => res.json())
      .then((data: { jobs: ScheduledJob[] }) => setJobs(data.jobs))
      .catch(() => setJobs([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const deleteJob = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const res = await fetch(`/api/jobs/${id}`, { method: "DELETE" });
        if (res.ok) {
          refresh();
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [refresh],
  );

  const triggerJob = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/jobs/${id}/trigger`, { method: "POST" });
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  return { jobs, loading, refresh, deleteJob, triggerJob };
}

export function useJobRuns(jobId: string | null) {
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    if (!jobId) {
      setRuns([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch(`/api/jobs/${jobId}/runs?limit=50`)
      .then((res) => res.json())
      .then((data: { runs: JobRun[] }) => setRuns(data.runs))
      .catch(() => setRuns([]))
      .finally(() => setLoading(false));
  }, [jobId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { runs, loading, refresh };
}

export function useJobFailureCount() {
  const [count, setCount] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    const poll = () => {
      fetch("/api/jobs/status")
        .then((res) => res.json())
        .then((data: { count: number }) => setCount(data.count))
        .catch(() => {});
    };
    poll();
    timerRef.current = setInterval(poll, 60_000);
    return () => clearInterval(timerRef.current);
  }, []);

  return { count };
}
