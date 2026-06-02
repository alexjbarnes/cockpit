"use client";

import { ArrowLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type AvailablePlugin, type InstalledPlugin, type Marketplace, type PluginScope, usePlugins } from "@/hooks/use-plugins";

type Tab = "installed" | "browse" | "marketplaces";

// Sentinel busy keys for marketplace actions that have no marketplace name of their own
// (plain strings a real marketplace name would never use).
const MKT_ADD = "__add__";
const MKT_ALL = "__all__";

export default function PluginsPage() {
  usePageHeader("Plugins", { hideActions: true });
  const router = useRouter();
  const searchParams = useSearchParams();
  const detailId = searchParams.get("detail");

  const {
    installed,
    available,
    marketplaces,
    loading,
    error,
    refresh,
    install,
    setEnabled,
    uninstall,
    update,
    addMarketplace,
    removeMarketplace,
    updateMarketplace,
  } = usePlugins();

  // When a detail param is present, show the detail view for that plugin.
  const detailPlugin = detailId ? (installed.find((p) => p.id === detailId) ?? null) : null;

  const [tab, setTab] = useState<Tab>("installed");
  const [busyId, setBusyId] = useState<string | null>(null);
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

  if (detailId) {
    return (
      <PluginDetailView
        plugin={detailPlugin}
        onBack={() => router.push("/plugins")}
        onSetEnabled={async (id, enabled, scope) => {
          const res = await setEnabled(id, enabled, scope);
          if (res.ok) refresh();
          return res;
        }}
        onUninstall={async (id, scope) => {
          const res = await uninstall(id, scope);
          return res;
        }}
        onUpdate={async (id) => {
          const res = await update(id);
          if (res.ok) refresh();
          return res;
        }}
      />
    );
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
              installed.map((p) => <PluginRow key={p.id} plugin={p} />)
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
  const [selected, setSelected] = useState<AvailablePlugin | null>(null);
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
                onClick={() => setSelected(p)}
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

      <Dialog open={!!selected} onOpenChange={() => setSelected(null)}>
        <DialogContent>
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="font-mono font-bold">{selected.name}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">@{selected.marketplaceName}</span>
                  {typeof selected.installCount === "number" && (
                    <Badge variant="secondary" className="text-[10px]">
                      {selected.installCount} installs
                    </Badge>
                  )}
                </div>
                {selected.description ? (
                  <p className="text-sm whitespace-pre-wrap">{selected.description}</p>
                ) : (
                  <p className="text-sm text-muted-foreground italic">No description available.</p>
                )}
                <div className="flex justify-end pt-2">
                  {installedIds.has(selected.pluginId) ? (
                    <span className="text-xs text-muted-foreground">Already installed</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => {
                        onInstall(selected.pluginId);
                        setSelected(null);
                      }}
                      disabled={busyId === selected.pluginId}
                    >
                      {busyId === selected.pluginId ? <Loader2 className="h-4 w-4 animate-spin" /> : "Install"}
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AvailableRow({
  plugin,
  installed,
  busy,
  onInstall,
  onClick,
}: {
  plugin: AvailablePlugin;
  installed: boolean;
  busy: boolean;
  onInstall: () => void;
  onClick: () => void;
}) {
  const { name, marketplace } = splitId(plugin.pluginId);
  return (
    <div className="flex items-center gap-3 rounded px-2 py-2 hover:bg-muted transition-colors">
      <button type="button" onClick={onClick} className="flex-1 min-w-0 text-left">
        <span className="block font-mono font-bold text-sm truncate">{name}</span>
        <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
          {marketplace && <span className="text-xs text-muted-foreground">@{marketplace}</span>}
          {typeof plugin.installCount === "number" && (
            <Badge variant="secondary" className="text-[10px]">
              {plugin.installCount} installs
            </Badge>
          )}
        </div>
        {plugin.description && <p className="text-xs text-muted-foreground truncate mt-0.5">{plugin.description}</p>}
      </button>
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

function PluginDetailView({
  plugin: rawPlugin,
  onBack,
  onSetEnabled,
  onUninstall,
  onUpdate,
}: {
  plugin: InstalledPlugin | null;
  onBack: () => void;
  onSetEnabled: (id: string, enabled: boolean, scope?: PluginScope) => Promise<{ ok: boolean; error?: string }>;
  onUninstall: (id: string, scope?: PluginScope) => Promise<{ ok: boolean; error?: string }>;
  onUpdate: (id: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  if (!rawPlugin) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        <BackLink onClick={onBack} />
        <p className="text-sm text-muted-foreground">Plugin not found.</p>
      </div>
    );
  }

  const plugin = rawPlugin;

  const { name, marketplace } = splitId(plugin.id);
  const mcpKeys = plugin.mcpServers ? Object.keys(plugin.mcpServers) : [];

  async function handleEnable(enabled: boolean) {
    setActionBusy("toggle");
    setActionError(null);
    const res = await onSetEnabled(plugin.id, enabled, plugin.scope);
    if (!res.ok) setActionError(res.error ?? "Failed to update plugin");
    setActionBusy(null);
  }

  async function handleUpdate() {
    setActionBusy("update");
    setActionError(null);
    const res = await onUpdate(plugin.id);
    if (!res.ok) setActionError(res.error ?? "Failed to update plugin");
    setActionBusy(null);
  }

  async function handleUninstall() {
    setConfirmUninstall(false);
    setActionBusy("uninstall");
    setActionError(null);
    const res = await onUninstall(plugin.id, plugin.scope);
    if (!res.ok) {
      setActionError(res.error ?? "Failed to uninstall plugin");
      setActionBusy(null);
    } else {
      onBack();
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-6">
      <BackLink onClick={onBack} />

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
            Uninstall <span className="font-mono font-bold">{plugin.id}</span>? This removes it from disk.
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

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
    >
      <ArrowLeft className="h-4 w-4" />
      Back to Installed
    </button>
  );
}

function splitId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf("@");
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: "" };
}

function PluginRow({ plugin }: { plugin: InstalledPlugin }) {
  const { name, marketplace } = splitId(plugin.id);
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(`/plugins?detail=${encodeURIComponent(plugin.id)}`)}
      className="flex w-full items-center gap-3 rounded px-2 py-2 hover:bg-muted transition-colors text-left"
    >
      <div className="flex-1 min-w-0">
        <span className="block font-mono font-bold text-sm truncate">{name}</span>
        <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
          {marketplace && <span className="text-xs text-muted-foreground">@{marketplace}</span>}
          <Badge variant="secondary" className="text-[10px]">
            v{plugin.version}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {plugin.scope}
          </Badge>
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${plugin.enabled ? "bg-green-500" : "bg-muted-foreground/40"}`} />
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </button>
  );
}

function formatDate(iso?: string): string {
  if (!iso) return "Unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "Unknown"
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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
  const [selectedMkt, setSelectedMkt] = useState<Marketplace | null>(null);
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
              <MarketplaceRow key={m.name} marketplace={m} disabled={anyBusy} onClick={() => setSelectedMkt(m)} />
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={!!selectedMkt} onOpenChange={() => setSelectedMkt(null)}>
        <DialogContent>
          {selectedMkt && (
            <>
              <DialogHeader>
                <DialogTitle className="font-mono font-bold">{selectedMkt.name}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <DetailRow label="Source" value={selectedMkt.source} mono />
                {selectedMkt.repo && <DetailRow label="Repo" value={selectedMkt.repo} mono />}
                <DetailRow label="Install location" value={selectedMkt.installLocation} mono />
                <div className="flex items-center gap-2 pt-3 border-t">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onUpdate(selectedMkt.name);
                      setSelectedMkt(null);
                    }}
                    disabled={anyBusy}
                  >
                    {busy === selectedMkt.name ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Update"}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      onRequestRemove(selectedMkt);
                      setSelectedMkt(null);
                    }}
                    disabled={anyBusy}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`text-right break-all max-w-[70%] ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

function MarketplaceRow({ marketplace, disabled, onClick }: { marketplace: Marketplace; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-3 rounded px-2 py-2 hover:bg-muted transition-colors text-left disabled:opacity-50"
    >
      <div className="flex-1 min-w-0">
        <span className="font-mono font-bold text-sm truncate">{marketplace.name}</span>
        <p className="text-xs text-muted-foreground truncate mt-0.5">{marketplace.source}</p>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </button>
  );
}
