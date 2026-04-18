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

export function UsageButton() {
  const [open, setOpen] = useState(false);
  const { usage, loading, error, refresh } = useUsage();

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
      <Button variant="ghost" size="icon" onClick={() => setOpen(true)} title="Account usage">
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
              <h2 className="text-base font-semibold">Account Usage</h2>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon" onClick={() => refresh(true)} disabled={loading} title="Refresh usage">
                  <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => setOpen(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {loading && !usage && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {error && !usage && <p className="text-sm text-muted-foreground py-4 text-center">{error}</p>}

            {usage && (
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
