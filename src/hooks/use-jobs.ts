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

  const stopJob = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const res = await fetch(`/api/jobs/${id}/stop`, { method: "POST" });
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

  return { jobs, loading, refresh, deleteJob, triggerJob, stopJob };
}

const PAGE_SIZE = 25;

export function useJobRuns(jobId: string | null) {
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const refresh = useCallback(() => {
    if (!jobId) {
      setRuns([]);
      setLoading(false);
      setHasMore(false);
      return;
    }
    setLoading(true);
    fetch(`/api/jobs/${jobId}/runs?limit=${PAGE_SIZE}`)
      .then((res) => res.json())
      .then((data: { runs: JobRun[]; hasMore?: boolean }) => {
        setRuns(data.runs);
        setHasMore(data.hasMore ?? false);
      })
      .catch(() => setRuns([]))
      .finally(() => setLoading(false));
  }, [jobId]);

  const loadMore = useCallback(() => {
    if (!jobId || loadingMore || !hasMore) return;
    setLoadingMore(true);
    fetch(`/api/jobs/${jobId}/runs?limit=${PAGE_SIZE}&offset=${runs.length}`)
      .then((res) => res.json())
      .then((data: { runs: JobRun[]; hasMore?: boolean }) => {
        setRuns((prev) => [...prev, ...data.runs]);
        setHasMore(data.hasMore ?? false);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [jobId, loadingMore, hasMore, runs.length]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { runs, loading, loadingMore, hasMore, refresh, loadMore };
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
