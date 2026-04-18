"use client";

import { useCallback, useEffect, useState } from "react";

type TransportType = "stdio" | "http" | "sse";

export interface McpServerInfo {
  name: string;
  scope: "user" | "project";
  type: TransportType;
  command?: string;
  url?: string;
}

export function useMcpServers(cwd?: string) {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);

    fetch(`/api/mcp-servers?${params}`)
      .then((res) => res.json())
      .then((data: { servers: McpServerInfo[] }) => setServers(data.servers))
      .catch(() => setServers([]))
      .finally(() => setLoading(false));
  }, [cwd]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const deleteServer = useCallback(
    async (name: string, scope: "user" | "project"): Promise<boolean> => {
      const params = new URLSearchParams({ scope });
      if (scope === "project" && cwd) params.set("cwd", cwd);

      try {
        const res = await fetch(`/api/mcp-servers/${encodeURIComponent(name)}?${params}`, {
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

  return { servers, loading, refresh, deleteServer };
}
