"use client";

import { useCallback, useEffect, useState } from "react";

export interface AgentInfo {
  name: string;
  scope: "user" | "project";
  description?: string;
  model?: string;
}

export function useAgents(cwd?: string) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);

    fetch(`/api/agents?${params}`)
      .then((res) => res.json())
      .then((data: { agents: AgentInfo[] }) => setAgents(data.agents))
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));
  }, [cwd]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const deleteAgent = useCallback(
    async (name: string, scope: "user" | "project"): Promise<boolean> => {
      const params = new URLSearchParams({ scope });
      if (scope === "project" && cwd) params.set("cwd", cwd);

      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(name)}?${params}`, {
          method: "DELETE",
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

  return { agents, loading, refresh, deleteAgent };
}
