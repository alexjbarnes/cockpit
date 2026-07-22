"use client";

import { BarChart3, Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useUsage } from "@/hooks/use-usage";
import type { UsageLimit } from "@/types";

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

export function UsageButton({ className, sessionId }: { className?: string; sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const [sessionModel, setSessionModel] = useState<string | null>(null);
  const { usage, loading, error, refresh } = useUsage();

  // The indicator follows the active session's provider: an OpenRouter
  // session shows credit spend, everything else keeps the Anthropic
  // subscription view. The model is resolved when the modal opens.
  useEffect(() => {
    if (!open || !sessionId) {
      setSessionModel(null);
      return;
    }
    fetch("/api/sessions")
      .then((res) => res.json())
      .then((data: Array<{ id: string; model?: string }>) => {
        if (Array.isArray(data)) setSessionModel(data.find((s) => s.id === sessionId)?.model ?? null);
      })
      .catch(() => setSessionModel(null));
  }, [open, sessionId]);

  const isOpenRouter = !!sessionModel?.startsWith("openrouter:");

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  const sevenDayMaxed = usage?.seven_day && usage.seven_day.utilization >= 100;
  const worst = sevenDayMaxed ? 100 : (usage?.five_hour?.utilization ?? 0);

  return (
    <>
      <Button variant="ghost" size="icon" onClick={() => setOpen(true)} title="Account usage" className={className}>
        <BarChart3 className={`h-4 w-4 ${usage ? iconColorClass(worst) : ""}`} />
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
              <h2 className="text-base font-semibold">{isOpenRouter ? "OpenRouter Usage" : "Account Usage"}</h2>
              <div className="flex gap-1">
                {!isOpenRouter && (
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

            {!isOpenRouter && loading && !usage && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {!isOpenRouter && error && !usage && <p className="text-sm text-muted-foreground py-4 text-center">{error}</p>}

            {!isOpenRouter && usage && (
              <>
                {usage.five_hour && <LimitBar label="5-hour limit" limit={usage.five_hour} />}
                {usage.seven_day && <LimitBar label="7-day limit" limit={usage.seven_day} />}
                {usage.seven_day_sonnet && <LimitBar label="7-day Sonnet" limit={usage.seven_day_sonnet} />}
                {usage.seven_day_opus && <LimitBar label="7-day Opus" limit={usage.seven_day_opus} />}

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
