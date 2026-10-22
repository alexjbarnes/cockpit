"use client";

import { countOf, formatCount, formatMs, formatPercent } from "@/lib/format-number";
import type { InsightsDurations, InsightsSpeed } from "@/types";
import { bucketTick, bucketTitle } from "./charts/kit";
import { Lines } from "./charts/lines";
import { RankedBars } from "./charts/ranked-bars";
import { BreakdownLegend, breakdownSegments, EmptyNote, type TabContext } from "./common";
import { Panel, PanelGrid } from "./panel";

function Pair({ label, d }: { label: string; d: InsightsDurations }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tabular-nums text-sm">
        {d.p50 === null ? "–" : formatMs(d.p50)}
        <span className="text-xs text-muted-foreground"> typical</span>
      </div>
      <div className="tabular-nums text-xs text-muted-foreground">{d.p90 === null ? "" : `${formatMs(d.p90)} slowest tenth`}</div>
    </div>
  );
}

function binLabel(from: number, to: number | null): string {
  if (to === null) return `Over ${formatMs(from)}`;
  if (from === 0) return `Under ${formatMs(to)}`;
  return `${formatMs(from)} to ${formatMs(to)}`;
}

export function SpeedTab({ data, ctx }: { data: InsightsSpeed; ctx: TabContext }) {
  const turnTotal = data.turnTime.modelMs + data.turnTime.toolsMs + data.turnTime.waitingMs + data.turnTime.otherMs;
  return (
    <div className="space-y-4">
      <Panel title="Models" note="Time to first token, and the whole response" testId="panel-models">
        {data.models.length === 0 ? (
          <EmptyNote>No requests in this range</EmptyNote>
        ) : (
          <div className="divide-y" data-testid="list-models">
            {data.models.map((m) => (
              <div key={m.model} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="min-w-0 truncate text-sm font-medium" title={m.model}>
                    {m.model}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatCount(m.requests)} requests
                    {m.errors > 0 && (
                      <span className="text-destructive">
                        {" "}
                        · {formatCount(m.errors)} errors ({formatPercent(m.errors / Math.max(1, m.requests + m.errors))})
                      </span>
                    )}
                  </span>
                </div>
                {m.providers.length > 0 && <div className="text-xs text-muted-foreground">{m.providers.join(", ")}</div>}
                <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Pair label="First token" d={m.ttft} />
                  <Pair label="Response" d={m.response} />
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">Output speed</div>
                    <div className="tabular-nums text-sm">{m.outputTps === null ? "–" : `${Math.round(m.outputTps)} tokens/s`}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
      <PanelGrid>
        <Panel title="Time to first token" note="Typical, per model" testId="panel-ttft">
          <Lines
            xs={data.buckets}
            series={data.ttftTrend}
            format={formatMs}
            tick={(x) => bucketTick(x, data.query.bucketMs, data.buckets.length)}
            title={(x) => bucketTitle(x, data.query.bucketMs)}
            rangeTitle={`${ctx.rangeTitle}, latest`}
            testId="chart-ttft"
          />
        </Panel>
        <Panel title="Where turns' time goes" note={countOf(data.turnTime.turns, "turn")} testId="panel-turn-time">
          {turnTotal === 0 ? (
            <EmptyNote>No turns in this range</EmptyNote>
          ) : (
            <div className="space-y-2">
              <div className="flex h-3 overflow-hidden rounded-full bg-muted">
                {breakdownSegments(data.turnTime).map((s) => (
                  <span key={s.label} title={s.label} style={{ width: `${(s.value / turnTotal) * 100}%`, background: s.color }} />
                ))}
              </div>
              <BreakdownLegend t={data.turnTime} />
            </div>
          )}
        </Panel>
      </PanelGrid>
      <Panel title="How long turns take" testId="panel-turn-durations">
        <RankedBars
          rows={data.turnDurations
            .filter((b) => b.count > 0)
            .map((b) => ({
              key: String(b.fromMs),
              label: binLabel(b.fromMs, b.toMs),
              value: b.count,
              display: countOf(b.count, "turn"),
            }))}
          limit={10}
          empty="No turns in this range"
          testId="list-turn-durations"
        />
      </Panel>
    </div>
  );
}
