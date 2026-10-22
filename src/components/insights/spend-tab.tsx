"use client";

import { useState } from "react";
import { Segmented } from "@/components/ui/segmented";
import { countOf, formatPercent, formatTokens } from "@/lib/format-number";
import type { InsightsSpend, InsightsSpendRow } from "@/types";
import { bucketTick, bucketTitle, TONES, timeOfDay } from "./charts/kit";
import { Lines } from "./charts/lines";
import { RankedBars } from "./charts/ranked-bars";
import { StackedBars } from "./charts/stacked-bars";
import { moneyNote, moneyText, sessionName, type TabContext, tokensText } from "./common";
import { Panel, PanelGrid } from "./panel";

const TOKEN_COLORS = { input: "var(--chart-1)", output: "var(--chart-2)", cacheRead: "var(--chart-3)", cacheWrite: "var(--chart-4)" };

function spendRows(rows: InsightsSpendRow[], onClick?: (key: string) => void) {
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    title: r.label,
    value: r.spend.usd,
    display: moneyText(r.spend),
    sub: [tokensText(r.tokens), countOf(r.requests, "request"), moneyNote(r.spend)].filter(Boolean).join(" · "),
    ...(onClick ? { onClick: () => onClick(r.key) } : {}),
  }));
}

export function SpendTab({ data, ctx }: { data: InsightsSpend; ctx: TabContext }) {
  const [split, setSplit] = useState<"model" | "provider">("model");
  const [ranked, setRanked] = useState<"sessions" | "projects" | "jobs">("sessions");
  const formatSpend = (v: number) => moneyText({ usd: v, apiEquivalentUsd: 0, unpricedRequests: 0 });
  return (
    <div className="space-y-4">
      <Panel
        title="Spend"
        note="Priced by each request's provider. Anthropic's models at API prices."
        action={
          <Segmented
            label="Split spend by"
            value={split}
            onChange={setSplit}
            options={[
              { value: "model", label: "Model" },
              { value: "provider", label: "Provider" },
            ]}
          />
        }
        testId="panel-spend"
      >
        <StackedBars
          buckets={data.buckets}
          bucketMs={data.query.bucketMs}
          series={split === "model" ? data.byModel : data.byProvider}
          format={formatSpend}
          rangeTitle={ctx.rangeTitle}
          testId="chart-spend"
        />
        {data.unpricedModels.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            No price for {data.unpricedModels.join(", ")}: their tokens count, their cost is left out.
          </p>
        )}
      </Panel>
      <PanelGrid>
        <Panel title="Tokens" testId="panel-tokens">
          <StackedBars
            buckets={data.buckets}
            bucketMs={data.query.bucketMs}
            series={data.tokens}
            colors={TOKEN_COLORS}
            format={formatTokens}
            rangeTitle={ctx.rangeTitle}
            testId="chart-tokens"
          />
        </Panel>
        <Panel title="Cache hit rate" note="Cache reads over everything sent" testId="panel-cache">
          <Lines
            xs={data.buckets}
            series={[{ key: "rate", label: "From cache", values: data.cacheHitRate, color: TONES.added }]}
            format={formatPercent}
            yMax={1}
            tick={(x) => bucketTick(x, data.query.bucketMs, data.buckets.length)}
            title={(x) => bucketTitle(x, data.query.bucketMs)}
            rangeTitle={`${ctx.rangeTitle}, latest`}
            testId="chart-cache"
          />
        </Panel>
        <Panel title="What it went on" testId="panel-purposes">
          <RankedBars rows={spendRows(data.purposes)} testId="list-purposes" />
        </Panel>
        <Panel title="By effort level" testId="panel-efforts">
          <RankedBars rows={spendRows(data.efforts)} color="var(--chart-2)" testId="list-efforts" />
        </Panel>
      </PanelGrid>
      {!ctx.scoped && (
        <Panel
          title="Ranked by spend"
          action={
            <Segmented
              label="Rank"
              value={ranked}
              onChange={setRanked}
              options={[
                { value: "sessions", label: "Sessions" },
                { value: "projects", label: "Projects" },
                { value: "jobs", label: "Jobs" },
              ]}
            />
          }
          testId="panel-ranked"
        >
          {ranked === "sessions" && (
            <RankedBars
              rows={data.rankedSessions.map((r) => ({
                ...spendRows([r])[0],
                label: sessionName(data.sessions, r.sessionId),
                sub: [data.sessions[r.sessionId]?.project?.label, tokensText(r.tokens), countOf(r.turns, "turn")]
                  .filter(Boolean)
                  .join(" · "),
                onClick: () => ctx.nav.session(r.sessionId),
              }))}
              testId="list-ranked-sessions"
            />
          )}
          {ranked === "projects" && (
            <RankedBars
              rows={data.rankedProjects.map((r) => ({
                ...spendRows([r])[0],
                sub: `${countOf(r.sessions, "session")} · ${tokensText(r.tokens)}`,
              }))}
              empty="No session in range belongs to a project"
              testId="list-ranked-projects"
            />
          )}
          {ranked === "jobs" && (
            <RankedBars
              rows={data.rankedJobs.map((r) => ({
                ...spendRows([r])[0],
                sub: `${countOf(r.sessions, "run")} · ${tokensText(r.tokens)}`,
              }))}
              empty="No scheduled job ran in range"
              testId="list-ranked-jobs"
            />
          )}
        </Panel>
      )}
      <Panel title="Most expensive turns" testId="panel-top-turns">
        <RankedBars
          rows={data.topTurns.map((t, i) => ({
            key: `${t.sessionId}-${t.traceId ?? i}`,
            label: t.prompt ?? "(no prompt recorded)",
            title: t.prompt ?? undefined,
            value: t.spend.usd,
            display: moneyText(t.spend),
            sub: [ctx.scoped ? null : sessionName(data.sessions, t.sessionId), timeOfDay(t.timeMs), tokensText(t.tokens)]
              .filter(Boolean)
              .join(" · "),
            ...(t.traceId ? { onClick: () => ctx.nav.turn(t.sessionId, t.traceId as string) } : {}),
          }))}
          testId="list-top-turns"
        />
      </Panel>
    </div>
  );
}
