"use client";

import { Check, ChevronRight, Loader2, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Provider, ProviderModel } from "@/types";

export function formatContext(len: number | undefined): string {
  if (!len) return "";
  if (len >= 1_000_000) return `${(len / 1_000_000).toFixed(len % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(len / 1000)}k`;
}

export function formatPerM(v: number): string {
  return `$${v % 1 === 0 ? v : v.toFixed(2).replace(/0$/, "")}`;
}

/** Row display for catalog models: the vendor prefix pushed the distinctive
 *  part of long ids ("nvidia/nemotron-…") out of view on narrow screens, so
 *  the name leads and vendor/context/price form a meta line. The free-variant
 *  suffix (":free" on OpenRouter, "-free" on Zen) is dropped from the name —
 *  the FREE badge already says it. */
export function splitProviderModelId(model: ProviderModel): { name: string; meta: string } {
  const slash = model.modelId.indexOf("/");
  const vendor = slash > 0 ? model.modelId.slice(0, slash) : "";
  const name = (slash > 0 ? model.modelId.slice(slash + 1) : model.modelId).replace(/[-:]free$/, "");
  const parts: string[] = [];
  if (vendor) parts.push(vendor);
  if (model.contextLength) parts.push(formatContext(model.contextLength));
  if (model.pricing && !model.free) parts.push(`${formatPerM(model.pricing.inPerM)}/${formatPerM(model.pricing.outPerM)}`);
  if (parts.length === 0 && model.displayName && model.displayName !== model.modelId) parts.push(model.displayName);
  return { name, meta: parts.join(" · ") };
}

export function FreeBadge({ model }: { model: ProviderModel }) {
  if (!model.free) return null;
  const until = model.expirationDate ? ` until ${model.expirationDate}` : "";
  return (
    <span
      className="rounded border border-green-600/60 bg-green-600/10 px-1.5 text-[10px] font-semibold text-green-600 dark:text-green-400"
      title={`Free${until}`}
    >
      FREE
    </span>
  );
}

/** W1-A connect card for the providers list page. */
export function OpenRouterCard({ provider, onChanged, onManage }: { provider: Provider; onChanged: () => void; onManage: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = !!provider.envVars.ANTHROPIC_AUTH_TOKEN;
  const freeCount = provider.models.filter((m) => m.free).length;
  const enabledCount = provider.enabledModels?.length ?? 0;

  const connect = async () => {
    if (!key.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/providers/openrouter/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setKey("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">OpenRouter</span>
        {connected ? (
          <span className="rounded bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">connected</span>
        ) : (
          <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">not connected</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {provider.models.length > 0 ? `${provider.models.length} models` : "no catalog yet"}
        </span>
      </div>
      {connected ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="text-green-600 dark:text-green-400 font-medium">{freeCount} free</span>
          <span>·</span>
          <span>{enabledCount} enabled for pickers</span>
          <Button variant="outline" size="sm" className="ml-auto h-7 text-xs" onClick={onManage}>
            Manage models
            <ChevronRight className="h-3 w-3 ml-1" />
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            type="password"
            placeholder="sk-or-…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="h-8 text-xs"
            data-testid="openrouter-key-input"
          />
          <Button size="sm" className="h-8 text-xs" onClick={connect} disabled={busy || !key.trim()} data-testid="openrouter-connect">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Connect"}
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

type Filter = "all" | "free" | "tools" | "enabled";

/** W2-A model browser, shared by every catalog-backed built-in provider
 *  (openrouter, zen). Filters that depend on catalog metadata (free flags,
 *  tool support) appear only when the provider's models carry it. */
export function ProviderModelBrowser({ provider, onChanged }: { provider: Provider; onChanged: () => void }) {
  const hasFreeMeta = provider.models.some((m) => m.free);
  const hasToolsMeta = provider.models.some((m) => m.supportsTools !== undefined);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = useMemo(() => new Set(provider.enabledModels ?? []), [provider.enabledModels]);

  const models = useMemo(() => {
    const q = search.trim().toLowerCase();
    return provider.models.filter((m) => {
      if (q && !m.modelId.toLowerCase().includes(q) && !m.displayName.toLowerCase().includes(q)) return false;
      if (filter === "free") return !!m.free;
      if (filter === "tools") return !!m.supportsTools;
      if (filter === "enabled") return enabled.has(m.modelId);
      return true;
    });
  }, [provider.models, search, filter, enabled]);

  const persistEnabled = async (ids: Set<string>) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/providers/${provider.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledModels: [...ids] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (id: string) => {
    const next = new Set(enabled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    void persistEnabled(next);
  };

  const sync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch(`/api/providers/${provider.id}/sync`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  };

  const syncedLabel = provider.syncedAt ? `synced ${formatAgo(provider.syncedAt)}` : "never synced";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{syncedLabel} · auto daily</span>
        <Button variant="outline" size="sm" className="ml-auto h-7 text-xs" onClick={sync} disabled={syncing} data-testid="openrouter-sync">
          <RefreshCw className={`h-3 w-3 mr-1 ${syncing ? "animate-spin" : ""}`} />
          Sync now
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[160px]">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search models…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-7 text-xs"
            data-testid="model-search"
          />
        </div>
        {(
          [
            ["all", "All"],
            ...(hasFreeMeta ? [["free", "Free"]] : []),
            ...(hasToolsMeta ? [["tools", "Tools"]] : []),
            ["enabled", "Enabled"],
          ] as [Filter, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`rounded px-2 py-1 text-xs transition-colors ${
              filter === value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="divide-y rounded-lg border">
        {models.map((m) => {
          const isOn = enabled.has(m.modelId);
          return (
            <button
              key={m.modelId}
              type="button"
              onClick={() => toggle(m.modelId)}
              disabled={saving}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/50 transition-colors"
              data-testid={`model-row-${m.modelId}`}
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                  isOn ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
                }`}
              >
                {isOn && <Check className="h-3 w-3" />}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex min-w-0 items-start gap-2">
                  <span className="min-w-0 break-all font-mono">{splitProviderModelId(m).name}</span>
                  <span className="shrink-0">
                    <FreeBadge model={m} />
                  </span>
                </span>
                {splitProviderModelId(m).meta && (
                  <span className="max-w-full text-[10px] text-muted-foreground tabular-nums">{splitProviderModelId(m).meta}</span>
                )}
              </span>
            </button>
          );
        })}
        {models.length === 0 && <p className="px-3 py-4 text-xs text-muted-foreground">No models match.</p>}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{enabled.size} enabled</span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void persistEnabled(new Set())} disabled={saving}>
            Disable all
          </Button>
          {hasFreeMeta && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              data-testid="enable-free"
              onClick={() => {
                const next = new Set(enabled);
                for (const m of provider.models) if (m.free) next.add(m.modelId);
                void persistEnabled(next);
              }}
              disabled={saving}
            >
              Enable free models
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              const next = new Set(enabled);
              for (const m of provider.models) next.add(m.modelId);
              void persistEnabled(next);
            }}
            disabled={saving}
          >
            Enable all
          </Button>
        </div>
      </div>
    </div>
  );
}

function formatAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Connect card for OpenCode Zen — key-only, models sync on connect, sessions
 *  run through cockpit's Anthropic-to-OpenAI format proxy. */
export function ZenCard({ provider, onChanged, onManage }: { provider: Provider; onChanged: () => void; onManage: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = !!provider.envVars.OPENCODE_API_KEY;

  const connect = async () => {
    if (!key.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/providers/zen/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setKey("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">OpenCode Zen</span>
        {connected ? (
          <span className="rounded bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">connected</span>
        ) : (
          <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">not connected</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {connected ? `${provider.models.length} models` : "OpenAI wire format · via cockpit proxy"}
        </span>
      </div>
      {connected && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{provider.enabledModels?.length ?? 0} enabled for pickers</span>
          <Button variant="outline" size="sm" className="ml-auto h-7 text-xs" onClick={onManage}>
            Manage models
            <ChevronRight className="h-3 w-3 ml-1" />
          </Button>
        </div>
      )}
      {!connected && (
        <div className="flex items-center gap-2">
          <Input
            type="password"
            placeholder="Zen API key…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="h-8 text-xs"
            data-testid="zen-key-input"
          />
          <Button size="sm" className="h-8 text-xs" onClick={connect} disabled={busy || !key.trim()} data-testid="zen-connect">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Connect"}
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
