"use client";

import { useCallback, useEffect, useState } from "react";

export type PluginScope = "user" | "project" | "local";

export interface InstalledPlugin {
  /** "name@marketplace" */
  id: string;
  version: string;
  scope: PluginScope;
  enabled: boolean;
  installPath: string;
  installedAt?: string;
  lastUpdated?: string;
  mcpServers?: Record<string, unknown>;
}

export interface AvailablePlugin {
  /** "name@marketplace" */
  pluginId: string;
  name: string;
  description?: string;
  marketplaceName: string;
  installCount?: number;
}

export interface Marketplace {
  name: string;
  source: string;
  repo?: string;
  installLocation: string;
}

interface MutationResult {
  ok: boolean;
  error?: string;
}

async function mutate(input: RequestInfo, init: RequestInit): Promise<MutationResult> {
  try {
    const res = await fetch(input, init);
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error || `Request failed (${res.status})` };
  } catch {
    return { ok: false, error: "Request failed" };
  }
}

export function usePlugins() {
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [available, setAvailable] = useState<AvailablePlugin[]>([]);
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/plugins")
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load plugins");
        return data as { installed: InstalledPlugin[]; available: AvailablePlugin[]; marketplaces: Marketplace[] };
      })
      .then((data) => {
        setInstalled(data.installed ?? []);
        setAvailable(data.available ?? []);
        setMarketplaces(data.marketplaces ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load plugins"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setEnabled = useCallback(
    async (id: string, enabled: boolean, scope?: PluginScope): Promise<MutationResult> => {
      const result = await mutate(`/api/plugins/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: enabled ? "enable" : "disable", scope }),
      });
      if (result.ok) refresh();
      return result;
    },
    [refresh],
  );

  const uninstall = useCallback(
    async (id: string, scope?: PluginScope): Promise<MutationResult> => {
      const params = new URLSearchParams();
      if (scope) params.set("scope", scope);
      const result = await mutate(`/api/plugins/${encodeURIComponent(id)}?${params}`, { method: "DELETE" });
      if (result.ok) refresh();
      return result;
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string): Promise<MutationResult> => {
      const result = await mutate(`/api/plugins/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update" }),
      });
      if (result.ok) refresh();
      return result;
    },
    [refresh],
  );

  const install = useCallback(
    async (id: string, scope: PluginScope = "user"): Promise<MutationResult> => {
      const result = await mutate("/api/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plugin: id, scope }),
      });
      if (result.ok) refresh();
      return result;
    },
    [refresh],
  );

  const addMarketplace = useCallback(
    async (source: string): Promise<MutationResult> => {
      const result = await mutate("/api/plugins/marketplaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", source }),
      });
      if (result.ok) refresh();
      return result;
    },
    [refresh],
  );

  const removeMarketplace = useCallback(
    async (name: string): Promise<MutationResult> => {
      const result = await mutate(`/api/plugins/marketplaces/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (result.ok) refresh();
      return result;
    },
    [refresh],
  );

  const updateMarketplace = useCallback(
    async (name?: string): Promise<MutationResult> => {
      const result = name
        ? await mutate(`/api/plugins/marketplaces/${encodeURIComponent(name)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "update" }),
          })
        : await mutate("/api/plugins/marketplaces", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "update" }),
          });
      if (result.ok) refresh();
      return result;
    },
    [refresh],
  );

  return {
    installed,
    available,
    marketplaces,
    loading,
    error,
    refresh,
    setEnabled,
    uninstall,
    update,
    install,
    addMarketplace,
    removeMarketplace,
    updateMarketplace,
  };
}
