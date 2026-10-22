"use client";

import { Loader2, RefreshCw, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { ActivityTab } from "@/components/insights/activity-tab";
import type { InsightsNav, TabContext } from "@/components/insights/common";
import { ContextTab } from "@/components/insights/context-tab";
import { HealthTab } from "@/components/insights/health-tab";
import { OverviewTab } from "@/components/insights/overview-tab";
import { SessionHeader } from "@/components/insights/session-header";
import { SpeedTab } from "@/components/insights/speed-tab";
import { SpendTab } from "@/components/insights/spend-tab";
import { ToolsTab } from "@/components/insights/tools-tab";
import { TurnTimeline } from "@/components/insights/turn-timeline";
import { TurnsTab } from "@/components/insights/turns-tab";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import { INSIGHTS_RANGES } from "@/lib/insights/query";
import { cn } from "@/lib/utils";
import type { InsightsPayload, InsightsRangeKey, InsightsView, TelemetryStats } from "@/types";

type TabId = Exclude<InsightsView, "turn">;

const TABS: ReadonlyArray<{ id: TabId; label: string; sessionOnly?: boolean }> = [
  { id: "overview", label: "Overview" },
  { id: "spend", label: "Spend" },
  { id: "speed", label: "Speed" },
  { id: "tools", label: "Tools" },
  { id: "health", label: "Health" },
  { id: "activity", label: "Activity" },
  { id: "turns", label: "Turns", sessionOnly: true },
  { id: "context", label: "Context", sessionOnly: true },
];

const RANGE_TITLES: Record<InsightsRangeKey, string> = { "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days" };

/**
 * One view's payload for the current filters. Every view fetched is kept, so
 * going back to a tab shows it at once while it refreshes underneath.
 */
function useInsights(view: InsightsView, range: InsightsRangeKey, session: string | undefined, turn: string | undefined, nonce: number) {
  const cache = useRef(new Map<string, InsightsPayload>());
  const [state, setState] = useState<{ key: string; data?: InsightsPayload; error?: string; loading: boolean }>({ key: "", loading: true });
  useEffect(() => {
    void nonce;
    const qs = new URLSearchParams({ view, range, tz: String(-new Date().getTimezoneOffset()) });
    if (session) qs.set("session", session);
    if (view === "turn" && turn) qs.set("turn", turn);
    const key = qs.toString();
    setState({ key, data: cache.current.get(key), loading: true });
    const ctrl = new AbortController();
    fetch(`/api/telemetry/insights?${key}`, { signal: ctrl.signal })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? res.statusText);
        cache.current.set(key, body as InsightsPayload);
        setState({ key, data: body as InsightsPayload, loading: false });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : String(err) }));
      });
    return () => ctrl.abort();
  }, [view, range, session, turn, nonce]);
  return state;
}

function InsightsPage() {
  usePageHeader("Insights", { hideActions: true });
  const params = useSearchParams();
  const router = useRouter();
  const scrollRef = useScrollRestoration<HTMLDivElement>("insights-scroll");
  const session = params.get("session") || undefined;
  const turn = params.get("turn") || undefined;
  const rawRange = params.get("range");
  const range: InsightsRangeKey = INSIGHTS_RANGES.includes(rawRange as InsightsRangeKey) ? (rawRange as InsightsRangeKey) : "7d";
  const tabs = TABS.filter((t) => session || !t.sessionOnly);
  const rawTab = params.get("tab");
  const tab: TabId = tabs.find((t) => t.id === rawTab)?.id ?? "overview";
  const view: InsightsView = tab === "turns" && turn && session ? "turn" : tab;

  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);
  const { data, error, loading } = useInsights(view, range, session, turn, nonce);

  // A phone shows only some of the tabs: keep the selected one in sight, as
  // when the page opens straight onto a session's Turns.
  const tabStrip = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tab and session change which tab is selected
  useEffect(() => {
    tabStrip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab, session]);

  const [stats, setStats] = useState<TelemetryStats | null>(null);
  useEffect(() => {
    fetch("/api/telemetry/stats")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: TelemetryStats | null) => setStats(s))
      .catch(() => setStats(null));
  }, []);

  /** Change the URL's filters: a push for a step the device's Back should
   *  undo (into a session or a turn), a replace for anything else. */
  const go = useCallback(
    (next: Record<string, string | undefined>, push = false) => {
      const sp = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v) sp.set(k, v);
        else sp.delete(k);
      }
      const url = `/insights${sp.size ? `?${sp.toString()}` : ""}`;
      if (push) router.push(url);
      else router.replace(url);
    },
    [params, router],
  );

  // Whether this page pushed the turn being shown, so its back button can
  // return through history; a turn opened from a link has nothing to go back to.
  const pushedTurn = useRef(false);
  const nav: InsightsNav = useMemo(
    () => ({
      session: (id) => go({ session: id, tab: "overview", turn: undefined }, true),
      turn: (sessionId, traceId) => {
        pushedTurn.current = true;
        go({ session: sessionId, tab: "turns", turn: traceId }, true);
      },
    }),
    [go],
  );
  const leaveTurn = () => {
    if (pushedTurn.current) router.back();
    else go({ turn: undefined });
    pushedTurn.current = false;
  };
  const ctx: TabContext = { nav, rangeTitle: RANGE_TITLES[range], scoped: !!session };
  const shown = data && data.view === view ? data : undefined;
  const scope = session ? shown?.sessions[session] : undefined;
  const nothingStored = stats !== null && !stats.enabled && (stats.store?.records ?? 0) === 0;

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4" data-testid="insights-page">
      <div className="sticky -top-4 z-10 -mx-4 -mt-4 border-b bg-background px-4 pt-3">
        <div className="flex items-center gap-2">
          <Segmented
            label="Range"
            value={range}
            onChange={(r) => go({ range: r })}
            options={INSIGHTS_RANGES.map((r) => ({ value: r, label: r }))}
            testId="insights-range"
          />
          {/* Shrinks to fit, so the row never wraps the refresh button onto a line of its own. */}
          <div className="min-w-0 flex-1">
            {session ? (
              <span
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border px-2 py-1 text-xs"
                data-testid="insights-scope"
              >
                <span className="truncate">{scope?.name ?? "One session"}</span>
                <button
                  type="button"
                  aria-label="Show all sessions"
                  onClick={() =>
                    go({ session: undefined, turn: undefined, tab: TABS.find((t) => t.id === tab)?.sessionOnly ? undefined : tab }, true)
                  }
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  data-testid="insights-clear-scope"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">All sessions</span>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={refresh}
            aria-label="Refresh"
            data-testid="insights-refresh"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
        <div
          ref={tabStrip}
          role="tablist"
          aria-label="Insights"
          className="-mx-4 mt-2 flex overflow-x-auto px-3"
          data-testid="insights-tabs"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === tab}
              onClick={() => go({ tab: t.id === "overview" ? undefined : t.id, turn: undefined })}
              className={cn(
                "shrink-0 border-b-2 px-3 py-2 text-sm transition-colors",
                t.id === tab ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              data-testid={`insights-tab-${t.id}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {stats && !stats.available ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          Telemetry is unavailable here: {stats.reason ?? "this Node has no SQLite"}.
        </p>
      ) : nothingStored ? (
        <div className="py-16 text-center text-sm text-muted-foreground" data-testid="insights-off">
          Telemetry is off, so there is nothing to show yet. Switch it on under{" "}
          <Link href="/settings/appearance" className="underline hover:text-foreground">
            Settings → Appearance
          </Link>
          .
        </div>
      ) : (
        <>
          {scope && <SessionHeader label={scope} />}
          {error && (
            <div
              className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid="insights-error"
            >
              {error}
            </div>
          )}
          {!shown ? (
            !error && (
              <div className="flex justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )
          ) : shown.view === "overview" ? (
            <OverviewTab data={shown} ctx={ctx} />
          ) : shown.view === "spend" ? (
            <SpendTab data={shown} ctx={ctx} />
          ) : shown.view === "speed" ? (
            <SpeedTab data={shown} ctx={ctx} />
          ) : shown.view === "tools" ? (
            <ToolsTab data={shown} ctx={ctx} />
          ) : shown.view === "health" ? (
            <HealthTab data={shown} ctx={ctx} />
          ) : shown.view === "activity" ? (
            <ActivityTab data={shown} ctx={ctx} />
          ) : shown.view === "turns" ? (
            <TurnsTab data={shown} ctx={ctx} />
          ) : shown.view === "turn" ? (
            <TurnTimeline data={shown} onBack={leaveTurn} />
          ) : (
            <ContextTab data={shown} ctx={ctx} />
          )}
        </>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <InsightsPage />
    </Suspense>
  );
}
