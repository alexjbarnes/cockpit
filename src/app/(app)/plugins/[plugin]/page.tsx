"use client";

import { ArrowLeft, Loader2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { InstalledPlugin } from "@/hooks/use-plugins";

function formatDate(iso?: string): string {
  if (!iso) return "Unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "Unknown"
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function splitId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf("@");
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: "" };
}

async function apiFetch(input: RequestInfo, init?: RequestInit): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(input, init);
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error || `Request failed (${res.status})` };
  } catch {
    return { ok: false, error: "Request failed" };
  }
}

export default function PluginDetailPage() {
  const params = useParams<{ plugin: string }>();
  const router = useRouter();
  const id = params.plugin;

  const [plugin, setPlugin] = useState<InstalledPlugin | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  const fetchPlugin = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/plugins/${encodeURIComponent(id)}`);
      if (res.status === 404) {
        setNotFound(true);
        setPlugin(null);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed to load plugin" }));
        setFetchError((data as { error?: string }).error ?? "Failed to load plugin");
        return;
      }
      const data = (await res.json()) as InstalledPlugin;
      setPlugin(data);
      setNotFound(false);
    } catch {
      setFetchError("Failed to load plugin");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchPlugin();
  }, [fetchPlugin]);

  async function handleEnable(enabled: boolean) {
    setActionBusy("toggle");
    setActionError(null);
    const res = await apiFetch(`/api/plugins/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: enabled ? "enable" : "disable", scope: plugin?.scope }),
    });
    if (!res.ok) setActionError(res.error ?? "Failed to update plugin");
    else await fetchPlugin();
    setActionBusy(null);
  }

  async function handleUpdate() {
    setActionBusy("update");
    setActionError(null);
    const res = await apiFetch(`/api/plugins/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update" }),
    });
    if (!res.ok) setActionError(res.error ?? "Failed to update plugin");
    else await fetchPlugin();
    setActionBusy(null);
  }

  async function handleUninstall() {
    setConfirmUninstall(false);
    setActionBusy("uninstall");
    setActionError(null);
    const params = new URLSearchParams();
    if (plugin?.scope) params.set("scope", plugin.scope);
    const res = await apiFetch(`/api/plugins/${encodeURIComponent(id)}?${params}`, { method: "DELETE" });
    if (!res.ok) {
      setActionError(res.error ?? "Failed to uninstall plugin");
      setActionBusy(null);
    } else {
      router.push("/plugins");
    }
  }

  const { name, marketplace } = splitId(id);

  if (loading) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        <Link
          href="/plugins"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Installed
        </Link>
        <p className="text-sm text-muted-foreground">Plugin not found.</p>
      </div>
    );
  }

  if (fetchError || !plugin) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        <Link
          href="/plugins"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Installed
        </Link>
        <div className="rounded border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500">{fetchError || "Plugin not found"}</div>
      </div>
    );
  }

  const mcpKeys = plugin.mcpServers ? Object.keys(plugin.mcpServers) : [];

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-6">
      <Link
        href="/plugins"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Installed
      </Link>

      <div>
        <h1 className="font-mono font-bold text-lg">{name}</h1>
        {marketplace && <p className="text-sm text-muted-foreground">@{marketplace}</p>}
      </div>

      {actionError && <div className="rounded border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500">{actionError}</div>}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Version</span>
            <span className="font-mono">{plugin.version}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Scope</span>
            <Badge variant="secondary" className="text-[10px]">
              {plugin.scope}
            </Badge>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">Status</span>
            <span className="flex items-center gap-1.5">
              <span className={`inline-block h-2 w-2 rounded-full ${plugin.enabled ? "bg-green-500" : "bg-muted-foreground/40"}`} />
              {plugin.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Install path</span>
            <span className="font-mono text-xs truncate ml-4 max-w-[60%] text-right" title={plugin.installPath}>
              {plugin.installPath}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Installed at</span>
            <span>{formatDate(plugin.installedAt)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Last updated</span>
            <span>{formatDate(plugin.lastUpdated)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">MCP servers</span>
            <span className="text-right max-w-[60%] truncate" title={mcpKeys.join(", ")}>
              {mcpKeys.length > 0 ? mcpKeys.join(", ") : "None"}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Actions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm">Update from marketplace source</span>
            <Button size="sm" variant="outline" onClick={handleUpdate} disabled={actionBusy !== null}>
              {actionBusy === "update" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Update"}
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">{plugin.enabled ? "Disable" : "Enable"} plugin</span>
            <Button
              size="sm"
              variant={plugin.enabled ? "outline" : "default"}
              onClick={() => handleEnable(!plugin.enabled)}
              disabled={actionBusy !== null}
            >
              {actionBusy === "toggle" ? <Loader2 className="h-4 w-4 animate-spin" /> : plugin.enabled ? "Disable" : "Enable"}
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Remove from disk</span>
            <Button size="sm" variant="destructive" onClick={() => setConfirmUninstall(true)} disabled={actionBusy !== null}>
              {actionBusy === "uninstall" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Uninstall"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirmUninstall} onOpenChange={setConfirmUninstall}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall Plugin</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">
            Uninstall <span className="font-mono font-bold">{id}</span>? This removes it from disk.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmUninstall(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleUninstall}>
              Uninstall
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
