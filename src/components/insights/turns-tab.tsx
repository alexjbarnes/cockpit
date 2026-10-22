"use client";

import { countOf, formatMs } from "@/lib/format-number";
import type { InsightsTurns } from "@/types";
import { timeOfDay } from "./charts/kit";
import { BreakdownLegend, breakdownSegments, EmptyNote, moneyText, type TabContext, tokensText } from "./common";
import { Panel } from "./panel";

/** A session's turns, newest first, each split into where its time went. */
export function TurnsTab({ data, ctx }: { data: InsightsTurns; ctx: TabContext }) {
  const session = data.query.session as string;
  return (
    <Panel title="Turns" note="Newest first. Open one for its timeline." testId="panel-turns">
      {data.turns.length === 0 ? (
        <EmptyNote>No turns in this range</EmptyNote>
      ) : (
        <div className="space-y-1">
          <BreakdownLegend />
          <ul className="divide-y" data-testid="list-turns">
            {data.turns.map((t) => {
              const total = Math.max(1, t.modelMs + t.toolsMs + t.waitingMs + t.otherMs);
              return (
                <li key={t.traceId}>
                  <button
                    type="button"
                    onClick={() => ctx.nav.turn(session, t.traceId)}
                    className="block w-full space-y-1 py-3 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                    data-testid="turn-row"
                  >
                    <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                      <span>{timeOfDay(t.startMs)}</span>
                      <span className="tabular-nums">
                        {formatMs(t.durationMs)} · {moneyText(t.spend)}
                      </span>
                    </div>
                    <div className="line-clamp-2 break-words text-sm">{t.prompt ?? "(no prompt recorded)"}</div>
                    <div className="flex h-2 overflow-hidden rounded-full bg-muted">
                      {breakdownSegments(t).map((s) => (
                        <span key={s.label} title={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} />
                      ))}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {[
                        countOf(t.requests, "request"),
                        countOf(t.toolCalls, "tool call"),
                        tokensText(t.tokens),
                        t.errors ? countOf(t.errors, "error") : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Panel>
  );
}
