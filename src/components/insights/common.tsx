"use client";

import { formatCount, formatMs, formatTokens, formatUSD } from "@/lib/format-number";
import type { InsightsMoney, InsightsSessionLabel } from "@/types";
import { TONES } from "./charts/kit";

/** Where a tab can send the user: into a session, or into one of its turns. */
export interface InsightsNav {
  session(id: string): void;
  turn(sessionId: string, traceId: string): void;
}

export interface TabContext {
  nav: InsightsNav;
  /** "Last 7 days" and the like, for a chart's whole-range readout. */
  rangeTitle: string;
  /** Whether the page shows one session rather than all. */
  scoped: boolean;
}

export function sessionName(sessions: Record<string, InsightsSessionLabel>, id: string): string {
  return sessions[id]?.name ?? `Session ${id.slice(0, 8)}`;
}

/** Spend as one string: "$1.20", with a + when some of it has no price. */
export function moneyText(m: InsightsMoney): string {
  return `${formatUSD(m.usd)}${m.unpricedRequests > 0 ? "+" : ""}`;
}

/** What qualifies a spend figure, if anything does. */
export function moneyNote(m: InsightsMoney): string | null {
  if (m.unpricedRequests > 0) return `${formatCount(m.unpricedRequests)} request${m.unpricedRequests === 1 ? "" : "s"} unpriced`;
  if (m.apiEquivalentUsd > 0 && m.apiEquivalentUsd >= m.usd - 1e-9) return "at API prices";
  if (m.apiEquivalentUsd > 0) return `${formatUSD(m.apiEquivalentUsd)} at API prices`;
  return null;
}

/** A turn's time split into the four parts every breakdown bar shows. */
export function breakdownSegments(t: { modelMs: number; toolsMs: number; waitingMs: number; otherMs: number }) {
  return [
    { name: "Model", value: t.modelMs, color: TONES.model },
    { name: "Tools", value: t.toolsMs, color: TONES.tools },
    { name: "Waiting for approval", value: t.waitingMs, color: TONES.waiting },
    { name: "Other", value: t.otherMs, color: TONES.other },
  ].map((s) => ({ ...s, label: `${s.name} ${formatMs(s.value)}` }));
}

/** The breakdown's colours, with each part's time when `t` is given. */
export function BreakdownLegend({ t }: { t?: { modelMs: number; toolsMs: number; waitingMs: number; otherMs: number } }) {
  const parts = breakdownSegments(t ?? { modelMs: 0, toolsMs: 0, waitingMs: 0, otherMs: 0 });
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {parts.map((s) => (
        <span key={s.color} className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
          {t ? s.label : s.name}
        </span>
      ))}
    </div>
  );
}

export function tokensText(n: number): string {
  return `${formatTokens(n)} tokens`;
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-muted-foreground">{children}</p>;
}
