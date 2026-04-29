import { useEffect, useState } from "react";
import type { SessionGroup } from "@/types";

export function useSessionForCwd(
  cwd: string,
  urlSessionId?: string | null,
): {
  sessionId: string | null;
  loading: boolean;
} {
  const [sessionId, setSessionId] = useState<string | null>(urlSessionId || null);
  const [loading, setLoading] = useState(!urlSessionId);

  useEffect(() => {
    if (urlSessionId) {
      setSessionId(urlSessionId);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    Promise.all([
      fetch("/api/sessions").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/sessions/pinned").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([sessionsData, pinnedData]) => {
        if (cancelled) return;
        const groups: SessionGroup[] = sessionsData?.groups || [];
        const pinnedIds = new Set<string>(pinnedData?.pinned || []);
        const group = groups.find((g) => g.cwd === cwd);
        if (!group) {
          setSessionId(null);
          setLoading(false);
          return;
        }
        // Prefer pinned sessions, fall back to any running session
        const candidates = group.sessions
          .filter((s) => pinnedIds.has(s.id) || s.status === "running")
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
        setSessionId(candidates.length > 0 ? candidates[0].id : null);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setSessionId(null);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, urlSessionId]);

  return { sessionId, loading };
}
