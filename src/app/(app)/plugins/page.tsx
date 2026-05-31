"use client";

import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type AvailablePlugin, type InstalledPlugin, type Marketplace, usePlugins } from "@/hooks/use-plugins";

type Tab = "installed" | "browse" | "marketplaces";

// Sentinel busy keys for marketplace actions that have no marketplace name of their own
// (plain strings a real marketplace name would never use).
const MKT_ADD = "__add__";
const MKT_ALL = "__all__";

export default function PluginsPage() {
  usePageHeader("Plugins", { hideActions: true });

  const {
    installed,
    available,
    marketplaces,
    loading,
    error,
    refresh,
    setEnabled,
    uninstall,
    install,
    addMarketplace,
    removeMarketplace,
    updateMarketplace,
  } = usePlugins();
  const [tab, setTab] = useState<Tab>("installed");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<InstalledPlugin | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mktBusy, setMktBusy] = useState<string | null>(null);
  const [confirmRemoveMkt, setConfirmRemoveMkt] = useState<Marketplace | null>(null);

  const installedIds = useMemo(() => new Set(installed.map((p) => p.id)), [installed]);

  async function handleInstall(pluginId: string) {
    setBusyId(pluginId);
    setActionError(null);
    const res = await install(pluginId, "user");
    if (!res.ok) setActionError(res.error ?? "Failed to install plugin");
    setBusyId(null);
  }

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

  async function handleAddMarketplace(source: string): Promise<boolean> {
    setMktBusy(MKT_ADD);
    setActionError(null);
    const res = await addMarketplace(source);
    if (!res.ok) setActionError(res.error ?? "Failed to add marketplace");
    setMktBusy(null);
    return res.ok;
  }

  async function handleUpdateMarketplace(name?: string) {
    setMktBusy(name ?? MKT_ALL);
    setActionError(null);
    const res = await updateMarketplace(name);
    if (!res.ok) setActionError(res.error ?? "Failed to update marketplace");
    setMktBusy(null);
  }

  async function handleRemoveMarketplace() {
    if (!confirmRemoveMkt) return;
    const target = confirmRemoveMkt;
    setConfirmRemoveMkt(null);
    setMktBusy(target.name);
    setActionError(null);
    const res = await removeMarketplace(target.name);
    if (!res.ok) setActionError(res.error ?? "Failed to remove marketplace");
    setMktBusy(null);
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

      {tab === "browse" && !loading && (
        <BrowseTab available={available} installedIds={installedIds} busyId={busyId} onInstall={handleInstall} />
      )}
      {tab === "marketplaces" && !loading && (
        <MarketplacesTab
          marketplaces={marketplaces}
          busy={mktBusy}
          onAdd={handleAddMarketplace}
          onUpdate={handleUpdateMarketplace}
          onRequestRemove={setConfirmRemoveMkt}
        />
      )}

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

      <Dialog open={!!confirmRemoveMkt} onOpenChange={() => setConfirmRemoveMkt(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Marketplace</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">
            Remove <span className="font-mono font-bold">{confirmRemoveMkt?.name}</span>? This removes the marketplace from your
            configuration.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmRemoveMkt(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRemoveMarketplace}>
              Remove
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

const BROWSE_LIMIT = 100;

function BrowseTab({
  available,
  installedIds,
  busyId,
  onInstall,
}: {
  available: AvailablePlugin[];
  installedIds: Set<string>;
  busyId: string | null;
  onInstall: (pluginId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q
    ? available.filter((p) => p.name.toLowerCase().includes(q) || (p.description?.toLowerCase().includes(q) ?? false))
    : available;
  const shown = filtered.slice(0, BROWSE_LIMIT);

  return (
    <div className="space-y-3">
      <Input placeholder="Search plugins..." value={query} onChange={(e) => setQuery(e.target.value)} />
      <p className="text-xs text-muted-foreground">Installs to user scope.</p>
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No plugins match your search.</p>
      ) : (
        <Card>
          <CardContent className="space-y-1 pt-4">
            {shown.map((p) => (
              <AvailableRow
                key={p.pluginId}
                plugin={p}
                installed={installedIds.has(p.pluginId)}
                busy={busyId === p.pluginId}
                onInstall={() => onInstall(p.pluginId)}
              />
            ))}
          </CardContent>
        </Card>
      )}
      {filtered.length > shown.length && (
        <p className="text-xs text-muted-foreground">
          Showing {shown.length} of {filtered.length}. Refine your search to narrow the list.
        </p>
      )}
    </div>
  );
}

function AvailableRow({
  plugin,
  installed,
  busy,
  onInstall,
}: {
  plugin: AvailablePlugin;
  installed: boolean;
  busy: boolean;
  onInstall: () => void;
}) {
  const { name, marketplace } = splitId(plugin.pluginId);
  return (
    <div className="flex items-center gap-3 rounded px-2 py-2 hover:bg-muted transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-sm truncate">{name}</span>
          {marketplace && <span className="text-xs text-muted-foreground truncate">@{marketplace}</span>}
          {typeof plugin.installCount === "number" && (
            <Badge variant="secondary" className="text-[10px]">
              {plugin.installCount} installs
            </Badge>
          )}
        </div>
        {plugin.description && <p className="text-xs text-muted-foreground truncate mt-0.5">{plugin.description}</p>}
      </div>
      <div className="shrink-0">
        {installed ? (
          <span className="px-2 text-xs text-muted-foreground">Installed</span>
        ) : (
          <Button size="sm" variant="outline" onClick={onInstall} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Install"}
          </Button>
        )}
      </div>
    </div>
  );
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

function MarketplacesTab({
  marketplaces,
  busy,
  onAdd,
  onUpdate,
  onRequestRemove,
}: {
  marketplaces: Marketplace[];
  busy: string | null;
  onAdd: (source: string) => Promise<boolean>;
  onUpdate: (name?: string) => void;
  onRequestRemove: (marketplace: Marketplace) => void;
}) {
  const [source, setSource] = useState("");
  const anyBusy = busy !== null;

  async function submit() {
    const s = source.trim();
    if (!s) return;
    const ok = await onAdd(s);
    if (ok) setSource("");
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          placeholder="owner/repo, URL, or local path"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <Button onClick={submit} disabled={anyBusy || !source.trim()}>
          {busy === MKT_ADD ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Add a GitHub repo, URL, or local path. Adds at user scope.</p>

      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{marketplaces.length} configured</span>
        <Button size="sm" variant="outline" onClick={() => onUpdate()} disabled={anyBusy || marketplaces.length === 0}>
          {busy === MKT_ALL ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Update all"}
        </Button>
      </div>

      {marketplaces.length === 0 ? (
        <p className="text-sm text-muted-foreground">No marketplaces configured. Add one above to browse its plugins.</p>
      ) : (
        <Card>
          <CardContent className="space-y-1 pt-4">
            {marketplaces.map((m) => (
              <MarketplaceRow
                key={m.name}
                marketplace={m}
                updating={busy === m.name}
                disabled={anyBusy}
                onUpdate={() => onUpdate(m.name)}
                onRemove={() => onRequestRemove(m)}
              />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function MarketplaceRow({
  marketplace,
  updating,
  disabled,
  onUpdate,
  onRemove,
}: {
  marketplace: Marketplace;
  updating: boolean;
  disabled: boolean;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded px-2 py-2 hover:bg-muted transition-colors">
      <div className="flex-1 min-w-0">
        <span className="font-mono font-bold text-sm truncate">{marketplace.name}</span>
        <p className="text-xs text-muted-foreground truncate mt-0.5">{marketplace.source}</p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={onUpdate}
          disabled={disabled}
          title="Update"
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-background disabled:opacity-50 transition-colors"
        >
          {updating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Update
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          title="Remove"
          className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:opacity-50 transition-colors"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
