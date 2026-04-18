"use client";

import { useCallback, useEffect, useState } from "react";

export interface HookEntry {
  type: "command" | "http" | "prompt" | "agent";
  command?: string;
  url?: string;
  matcher?: string;
  timeout?: number;
  [key: string]: unknown;
}

export interface HookInfo {
  event: string;
  hooks: HookEntry[];
  scope: "global" | "project" | "project-local";
  filePath: string;
}

export function useHooks(cwd?: string) {
  const [hooks, setHooks] = useState<HookInfo[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);

    fetch(`/api/hooks?${params}`)
      .then((res) => res.json())
      .then((data: { hooks: HookInfo[]; events: string[] }) => {
        setHooks(data.hooks);
        setEvents(data.events);
      })
      .catch(() => setHooks([]))
      .finally(() => setLoading(false));
  }, [cwd]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveHooks = useCallback(
    async (filePath: string, event: string, entries: HookEntry[]): Promise<boolean> => {
      const params = new URLSearchParams();
      if (cwd) params.set("cwd", cwd);

      try {
        const res = await fetch(`/api/hooks?${params}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath, event, hooks: entries }),
        });
        if (res.ok) {
          refresh();
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [cwd, refresh],
  );

  return { hooks, events, loading, refresh, saveHooks };
}
