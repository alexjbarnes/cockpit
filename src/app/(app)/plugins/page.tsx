"use client";

import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type InstalledPlugin, usePlugins } from "@/hooks/use-plugins";

type Tab = "installed" | "browse" | "marketplaces";

export default function PluginsPage() {
  usePageHeader("Plugins", { hideActions: true });

  const { installed, available, marketplaces, loading, error, refresh, setEnabled, uninstall } = usePlugins();
  const [tab, setTab] = useState<Tab>("installed");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<InstalledPlugin | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleToggle(p: InstalledPlugin) {
    setBusyId(p.id);
    setActionError(null);
    const res = await setEnabled(p.id, !p.enabled, p.scope);
    if (!res.ok) setActionError(res.error ?? "Failed to update plugin");
    setBusyId(null);
  }

  async function handleRemove() {
    if (!confirmRemove) return;
    const target = confirmRemove;
    setConfirmRemove(null);
    setBusyId(target.id);
    setActionError(null);
    const res = await uninstall(target.id, target.scope);
    if (!res.ok) setActionError(res.error ?? "Failed to uninstall plugin");
    setBusyId(null);
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <TabButton active={tab === "installed"} onClick={() => setTab("installed")} label="Installed" count={installed.length} />
          <TabButton active={tab === "browse"} onClick={() => setTab("browse")} label="Browse" count={available.length} />
          <TabButton
            active={tab === "marketplaces"}
            onClick={() => setTab("marketplaces")}
            label="Marketplaces"
            count={marketplaces.length}
          />
        </div>
        <Button size="sm" variant="ghost" onClick={refresh} disabled={loading} title="Refresh">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {error && <div className="rounded border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500">{error}</div>}
      {actionError && <div className="rounded border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500">{actionError}</div>}

      {loading && installed.length === 0 && <p className="text-sm text-muted-foreground">Loading plugins...</p>}

      {tab === "installed" && !loading && (
        <Card>
          <CardContent className="space-y-1 pt-4">
            {installed.length === 0 ? (
              <p className="text-sm text-muted-foreground">No plugins installed. Browse a marketplace to add one.</p>
            ) : (
              installed.map((p) => (
                <PluginRow
                  key={p.id}
                  plugin={p}
                  busy={busyId === p.id}
                  onToggle={() => handleToggle(p)}
                  onRemove={() => setConfirmRemove(p)}
                />
              ))
            )}
          </CardContent>
        </Card>
      )}

      {tab === "browse" && <Placeholder text={`Catalog browser coming next (${available.length} plugins available).`} />}
      {tab === "marketplaces" && <Placeholder text={`Marketplace management coming next (${marketplaces.length} configured).`} />}

      <Dialog open={!!confirmRemove} onOpenChange={() => setConfirmRemove(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall Plugin</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">
            Uninstall <span className="font-mono font-bold">{confirmRemove?.id}</span>? This removes it from disk.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmRemove(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRemove}>
              Uninstall
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm transition-colors ${active ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
    >
      {label}
      <span className="ml-1.5 text-xs text-muted-foreground">{count}</span>
    </button>
  );
}

function Placeholder({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

function splitId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf("@");
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: "" };
}

function PluginRow({
  plugin,
  busy,
  onToggle,
  onRemove,
}: {
  plugin: InstalledPlugin;
  busy: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const { name, marketplace } = splitId(plugin.id);
  return (
    <div className="flex items-center gap-3 rounded px-2 py-2 hover:bg-muted transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-sm truncate">{name}</span>
          {marketplace && <span className="text-xs text-muted-foreground truncate">@{marketplace}</span>}
          <Badge variant="secondary" className="text-[10px]">
            v{plugin.version}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {plugin.scope}
          </Badge>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          title={plugin.enabled ? "Disable" : "Enable"}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-background disabled:opacity-50 transition-colors"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <span className={`inline-block h-2 w-2 rounded-full ${plugin.enabled ? "bg-green-500" : "bg-muted-foreground/40"}`} />
          )}
          {plugin.enabled ? "Enabled" : "Disabled"}
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          title="Uninstall"
          className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:opacity-50 transition-colors"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
