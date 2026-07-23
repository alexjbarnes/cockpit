"use client";

import { BarChart3, Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useUsage } from "@/hooks/use-usage";
import type { ScopedUsageLimit, UsageLimit } from "@/types";

function formatResetTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m`;
}

function utilizationColor(pct: number): string {
  if (pct > 80) return "#ef4444";
  if (pct > 50) return "#f97316";
  return "#22c55e";
}

function iconColorClass(pct: number): string {
  if (pct > 80) return "text-red-500";
  if (pct > 50) return "text-orange-500";
  return "text-green-500";
}

/** Bar label for one `limits` entry: the session window, the all-models
 *  weekly cap, or a model-scoped weekly cap named by the API (e.g. Fable). */
function scopedLimitLabel(l: ScopedUsageLimit): string {
  if (l.kind === "session") return "5-hour limit";
  if (l.kind === "weekly_all") return "7-day · all models";
  const scopeName = l.scope?.model?.display_name ?? l.scope?.surface;
  if (scopeName) return `7-day · ${scopeName}`;
  return l.kind.replace(/_/g, " ");
}

function LimitBar({ label, limit }: { label: string; limit: UsageLimit }) {
  const pct = Math.round(limit.utilization);
  const color = utilizationColor(pct);

  return (
    <div className="mb-4 last:mb-0">
      <div className="flex justify-between text-sm mb-1">
        <span>{label}</span>
        <span className="text-muted-foreground">
          {pct}% &middot; resets in {formatResetTime(limit.resets_at)}
        </span>
      </div>
      <div className="h-2.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

interface OpenRouterUsageData {
  usage: number;
  usageDaily: number;
  usageWeekly: number;
  usageMonthly: number;
  limit: number | null;
  limitRemaining: number | null;
  isFreeTier: boolean;
}

function CreditRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm mb-2 last:mb-0">
      <span>{label}</span>
      <span className="text-muted-foreground tabular-nums">{value}</span>
    </div>
  );
}

/** OpenRouter sessions get credit spend instead of subscription limits. */
function OpenRouterUsagePanel() {
  const [data, setData] = useState<OpenRouterUsageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/providers/openrouter/usage")
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        setData(await res.json());
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) return <p className="text-sm text-muted-foreground py-4 text-center">{error}</p>;
  if (!data) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const pct = data.limit && data.limit > 0 ? Math.min(100, Math.round((data.usage / data.limit) * 100)) : null;
  return (
    <>
      <CreditRow label="Spend today" value={`$${data.usageDaily.toFixed(2)}`} />
      <CreditRow label="Spend this week" value={`$${data.usageWeekly.toFixed(2)}`} />
      <CreditRow label="Spend this month" value={`$${data.usageMonthly.toFixed(2)}`} />
      {pct !== null && (
        <div className="mt-4">
          <div className="flex justify-between text-sm mb-1">
            <span>Key limit</span>
            <span className="text-muted-foreground tabular-nums">
              ${data.limitRemaining?.toFixed(2) ?? "?"} remaining of ${data.limit?.toFixed(2)}
            </span>
          </div>
          <div className="h-2.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: utilizationColor(pct) }} />
          </div>
        </div>
      )}
      {data.isFreeTier && <p className="mt-3 text-xs text-muted-foreground">Free-tier account: free-model rate limits apply.</p>}
    </>
  );
}

interface MeteredWindow {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUSD: number;
}

interface BuiltinUsageData {
  spend: { today: MeteredWindow; week: MeteredWindow; month: MeteredWindow };
  balance: { currency: string; totalBalance: number; grantedBalance?: number; toppedUpBalance?: number } | null;
  balanceError?: string;
}

function formatUSD(v: number): string {
  if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

/** Zen has no spend API, so cockpit meters proxied traffic locally; DeepSeek
 *  shows the account balance from their API. */
function BuiltinUsagePanel({ providerId }: { providerId: string }) {
  const [data, setData] = useState<BuiltinUsageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/providers/${providerId}/usage`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        setData(await res.json());
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [providerId]);

  if (error) return <p className="text-sm text-muted-foreground py-4 text-center">{error}</p>;
  if (!data) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      {data.balance && (
        <>
          <CreditRow label="Account balance" value={`${formatUSD(data.balance.totalBalance)} ${data.balance.currency}`} />
          {(data.balance.grantedBalance ?? 0) > 0 && (
            <CreditRow label="of which granted" value={`${formatUSD(data.balance.grantedBalance ?? 0)} ${data.balance.currency}`} />
          )}
        </>
      )}
      {data.balanceError && <p className="text-xs text-destructive mb-2">Balance unavailable: {data.balanceError}</p>}
      {providerId === "zen" && (
        <>
          <CreditRow label="Spend today (est.)" value={formatUSD(data.spend.today.costUSD)} />
          <CreditRow label="Spend this week (est.)" value={formatUSD(data.spend.week.costUSD)} />
          <CreditRow label="Spend this month (est.)" value={formatUSD(data.spend.month.costUSD)} />
          <CreditRow label="Requests this week" value={String(data.spend.week.requests)} />
          <p className="mt-3 text-xs text-muted-foreground">
            Metered by cockpit from proxied sessions at current model prices. Billing lives in your opencode.ai workspace console.
          </p>
        </>
      )}
      {providerId === "deepseek" && (
        <p className="mt-3 text-xs text-muted-foreground">Sessions bill your DeepSeek account directly; top up at platform.deepseek.com.</p>
      )}
    </>
  );
}

export function UsageButton({ className, sessionModel }: { className?: string; sessionModel?: string }) {
  const [open, setOpen] = useState(false);
  const { usage, loading, error, refresh } = useUsage();

  // The indicator follows the active session's provider: OpenRouter sessions
  // show credit spend, zen shows cockpit-metered spend, deepseek shows the
  // account balance, everything else keeps the Anthropic subscription view.
  // The model arrives live from the session view via the shell context — the
  // sessions list API omits model for scanned sessions, so it can never be
  // the source of truth here.
  const prefix = sessionModel?.split(":")[0];
  const PROVIDER_TITLES: Record<string, string> = {
    openrouter: "OpenRouter Usage",
    zen: "OpenCode Zen Usage",
    deepseek: "DeepSeek Usage",
  };
  const providerId = prefix && PROVIDER_TITLES[prefix] ? prefix : null;
  const isOpenRouter = providerId === "openrouter";

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  // The oauth/usage `limits` array is the current API shape and the only
  // carrier of model-scoped weekly limits (e.g. Fable); the legacy fields
  // remain as fallback for older response shapes.
  const scopedLimits = usage?.limits ?? [];
  const sevenDayMaxed = usage?.seven_day && usage.seven_day.utilization >= 100;
  const worst =
    scopedLimits.length > 0
      ? Math.max(0, ...scopedLimits.map((l) => l.percent))
      : sevenDayMaxed
        ? 100
        : (usage?.five_hour?.utilization ?? 0);

  // The icon reflects the ACTIVE session's provider. Anthropic subscription
  // pressure says nothing about an OpenRouter or zen session, so a foreign
  // session gets the neutral icon rather than a red one inherited from a
  // limit it does not consume. Their spend is a credit balance, not a quota
  // with a percentage, so there is no honest colour to show.
  const iconClass = providerId ? "" : usage ? iconColorClass(worst) : "";

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        title={providerId ? `${PROVIDER_TITLES[providerId]} (Anthropic limits do not apply)` : "Account usage"}
        className={className}
      >
        <BarChart3 className={`h-4 w-4 ${iconClass}`} />
      </Button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-md mx-4 rounded-lg border bg-background p-5 shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">{providerId ? PROVIDER_TITLES[providerId] : "Account Usage"}</h2>
              <div className="flex gap-1">
                {!providerId && (
                  <Button variant="ghost" size="icon" onClick={() => refresh(true)} disabled={loading} title="Refresh usage">
                    <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                  </Button>
                )}
                <Button variant="ghost" size="icon" onClick={() => setOpen(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {isOpenRouter && <OpenRouterUsagePanel />}
            {providerId && !isOpenRouter && <BuiltinUsagePanel providerId={providerId} />}

            {!providerId && loading && !usage && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {!providerId && error && !usage && <p className="text-sm text-muted-foreground py-4 text-center">{error}</p>}

            {!providerId && usage && (
              <>
                {scopedLimits.length > 0 ? (
                  scopedLimits.map((l) => (
                    <LimitBar
                      key={`${l.kind}-${l.scope?.model?.display_name ?? l.scope?.surface ?? ""}`}
                      label={scopedLimitLabel(l)}
                      limit={{ utilization: l.percent, resets_at: l.resets_at }}
                    />
                  ))
                ) : (
                  <>
                    {usage.five_hour && <LimitBar label="5-hour limit" limit={usage.five_hour} />}
                    {usage.seven_day && <LimitBar label="7-day limit" limit={usage.seven_day} />}
                    {usage.seven_day_sonnet && <LimitBar label="7-day Sonnet" limit={usage.seven_day_sonnet} />}
                    {usage.seven_day_opus && <LimitBar label="7-day Opus" limit={usage.seven_day_opus} />}
                  </>
                )}

                {usage.extra_usage?.enabled && (
                  <div className="mt-4 pt-3 border-t text-sm">
                    <div className="flex justify-between">
                      <span>Extra usage credits</span>
                      <span className="font-medium">${usage.extra_usage.remaining_credits.toFixed(2)} remaining</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
