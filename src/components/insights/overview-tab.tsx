"use client";

import { countOf, formatCount, formatMs, formatPercent, formatTokens } from "@/lib/format-number";
import { totalTokens } from "@/lib/insights/pricing";
import type { InsightsOverview } from "@/types";
import { RankedBars } from "./charts/ranked-bars";
import { StackedBars } from "./charts/stacked-bars";
import { StatTile } from "./charts/stat-tile";
import { moneyNote, moneyText, sessionName, type TabContext, tokensText } from "./common";
import { Panel } from "./panel";

export function OverviewTab({ data, ctx }: { data: InsightsOverview; ctx: TabContext }) {
  const t = data.totals;
  const formatSpend = (v: number) => moneyText({ usd: v, apiEquivalentUsd: 0, unpricedRequests: 0 });
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="insights-tiles">
        <StatTile label="Spend" value={moneyText(t.spend)} sub={moneyNote(t.spend) ?? countOf(t.requests, "request")} testId="tile-spend" />
        <StatTile
          label="Tokens"
          value={formatTokens(totalTokens(t.tokens))}
          sub={t.cacheHitRate === null ? "nothing sent" : `${formatPercent(t.cacheHitRate)} from cache`}
          testId="tile-tokens"
        />
        <StatTile
          label="Turns"
          value={formatCount(t.turns)}
          sub={t.medianTurnMs === null ? "none" : `median ${formatMs(t.medianTurnMs)}`}
          testId="tile-turns"
        />
        <StatTile
          label="Tool calls"
          value={formatCount(t.toolCalls)}
          sub={t.toolFailures ? `${formatCount(t.toolFailures)} failed` : "none failed"}
          testId="tile-tools"
        />
        <StatTile
          label="Waiting on you"
          value={t.waitingMs > 0 ? formatMs(t.waitingMs) : "0s"}
          sub={`${countOf(t.waits, "answer")} from you`}
          testId="tile-waiting"
        />
        <StatTile label="API errors" value={formatCount(t.apiErrors)} sub={countOf(t.retries, "retry", "retries")} testId="tile-errors" />
        <StatTile
          label="Lines changed"
          value={`+${formatCount(t.linesAdded)} −${formatCount(t.linesRemoved)}`}
          sub="added and removed"
          testId="tile-lines"
        />
        <StatTile label="Prompts" value={formatCount(t.prompts)} sub="sent" testId="tile-prompts" />
      </div>
      <Panel title="Spend by model" note="Priced by the provider that served each request" testId="panel-spend-by-model">
        <StackedBars
          buckets={data.buckets}
          bucketMs={data.query.bucketMs}
          series={data.spendByModel}
          format={formatSpend}
          rangeTitle={ctx.rangeTitle}
          testId="chart-spend-by-model"
        />
      </Panel>
      {!ctx.scoped && (
        <Panel title="Top sessions" note="By spend" testId="panel-top-sessions">
          <RankedBars
            rows={data.topSessions.map((s) => ({
              key: s.sessionId,
              label: sessionName(data.sessions, s.sessionId),
              title: sessionName(data.sessions, s.sessionId),
              value: s.spend.usd,
              display: moneyText(s.spend),
              sub: [data.sessions[s.sessionId]?.project?.label, tokensText(s.tokens), countOf(s.turns, "turn")].filter(Boolean).join(" · "),
              onClick: () => ctx.nav.session(s.sessionId),
            }))}
            testId="list-top-sessions"
          />
        </Panel>
      )}
    </div>
  );
}
