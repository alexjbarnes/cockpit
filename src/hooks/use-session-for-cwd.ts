import { useState, useEffect } from "react";
import { getActiveSessions } from "@/components/sidebar";
import type { SessionGroup } from "@/types";

export function useSessionForCwd(cwd: string, urlSessionId?: string | null): {
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

    fetch("/api/sessions")
      .then((res) => {
        if (!res.ok) throw new Error("Failed");
        return res.json();
      })
      .then((data: { groups: SessionGroup[] }) => {
        if (cancelled) return;
        const activeIds = getActiveSessions();
        const group = data.groups.find((g) => g.cwd === cwd);
        if (!group) {
          setSessionId(null);
          setLoading(false);
          return;
        }
        const candidates = group.sessions
          .filter((s) => activeIds.has(s.id))
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

    return () => { cancelled = true; };
  }, [cwd, urlSessionId]);

  return { sessionId, loading };
}
