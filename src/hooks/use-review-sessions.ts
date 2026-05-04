"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { SessionInfo } from "@/types";

export interface ReviewSession {
  id: string;
  name: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  lastActiveAt: number;
  status: "idle" | "running";
  pendingRequestCount: number;
}

const REVIEW_NAME_RE = /^Review:\s*(?:(.+?)\/)?(.+?)#(\d+)(?:\s+-\s+(.*))?$/;

function parseReviewSession(s: SessionInfo): ReviewSession | null {
  const match = REVIEW_NAME_RE.exec(s.name);
  if (!match) return null;
  return {
    id: s.id,
    name: s.name,
    owner: match[1] || "",
    repo: match[2],
    number: parseInt(match[3], 10),
    title: match[4] || "",
    lastActiveAt: s.lastActiveAt,
    status: s.status,
    pendingRequestCount: s.pendingRequestCount ?? 0,
  };
}

let cached: ReviewSession[] | null = null;
let lastFetchAt = 0;

export function useReviewSessions(limit = 8): { sessions: ReviewSession[]; loading: boolean } {
  const [sessions, setSessions] = useState<ReviewSession[]>(cached || []);
  const [loading, setLoading] = useState(!cached);
  const pathname = usePathname();

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname triggers refetch on navigation
  useEffect(() => {
    const stale = Date.now() - lastFetchAt > 60_000;
    if (cached && !stale) {
      setSessions(cached);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    fetch(`/api/sessions?type=reviews&limit=${limit}`)
      .then((r) => (r.ok ? r.json() : { sessions: [] }))
      .then((data) => {
        if (cancelled) return;
        const raw: SessionInfo[] = data.sessions || [];
        const parsed = raw.map(parseReviewSession).filter((r): r is ReviewSession => r !== null);
        cached = parsed;
        lastFetchAt = Date.now();
        setSessions(parsed);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pathname, limit]);

  return { sessions, loading };
}
