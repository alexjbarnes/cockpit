"use client";

import { useCallback, useEffect, useState } from "react";

export type McpServerStatus = "connected" | "needs-auth" | "pending" | "failed";

export interface McpServerEntry {
  name: string;
  target: string;
  scope: "connector" | "local";
  status: McpServerStatus;
  detail?: string;
}

/** What the CLI produced when a sign-in was started. */
export interface LoginStart {
  ok: boolean;
  kind?: "connector" | "redirect";
  url?: string;
  /** Present for the redirect kind: the id the pasted URL is submitted against. */
  id?: string;
  error?: string;
}

export interface MutationResult {
  ok: boolean;
  error?: string;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error || fallback;
}

export function useMcpConnectors(cwd?: string) {
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    (force = false) => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (cwd) params.set("cwd", cwd);
      if (force) params.set("refresh", "1");

      fetch(`/api/mcp-servers/connectors?${params}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(await readError(res, "Failed to list MCP servers"));
          return (await res.json()) as { servers: McpServerEntry[]; checkedAt: number };
        })
        .then((data) => {
          setServers(data.servers ?? []);
          setCheckedAt(data.checkedAt ?? null);
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Failed to list MCP servers"))
        .finally(() => setLoading(false));
    },
    [cwd],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startLogin = useCallback(
    async (name: string): Promise<LoginStart> => {
      try {
        const res = await fetch("/api/mcp-servers/connectors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "login", name, cwd }),
        });
        if (!res.ok) return { ok: false, error: await readError(res, "Could not start the sign-in") };
        return (await res.json()) as LoginStart;
      } catch {
        return { ok: false, error: "Could not start the sign-in" };
      }
    },
    [cwd],
  );

  const submitRedirect = useCallback(
    async (id: string, redirectUrl: string): Promise<MutationResult> => {
      try {
        const res = await fetch("/api/mcp-servers/connectors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "submit", id, redirectUrl, cwd }),
        });
        if (!res.ok) return { ok: false, error: await readError(res, "Sign-in failed") };
        return { ok: true };
      } catch {
        return { ok: false, error: "Sign-in failed" };
      }
    },
    [cwd],
  );

  const cancelLogin = useCallback(async (id: string): Promise<void> => {
    await fetch(`/api/mcp-servers/connectors?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  }, []);

  const logout = useCallback(
    async (name: string): Promise<MutationResult> => {
      try {
        const res = await fetch("/api/mcp-servers/connectors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "logout", name, cwd }),
        });
        if (!res.ok) return { ok: false, error: await readError(res, "Sign out failed") };
        return { ok: true };
      } catch {
        return { ok: false, error: "Sign out failed" };
      }
    },
    [cwd],
  );

  return { servers, checkedAt, loading, error, refresh, startLogin, submitRedirect, cancelLogin, logout };
}
