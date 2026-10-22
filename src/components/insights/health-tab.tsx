"use client";

import { countOf, formatCount, formatMs } from "@/lib/format-number";
import type { InsightsHealth } from "@/types";
import { TONES, timeOfDay } from "./charts/kit";
import { RankedBars } from "./charts/ranked-bars";
import { StackedBars } from "./charts/stacked-bars";
import { EmptyNote, sessionName, type TabContext } from "./common";
import { Panel, PanelGrid } from "./panel";

export function HealthTab({ data, ctx }: { data: InsightsHealth; ctx: TabContext }) {
  return (
    <div className="space-y-4">
      <Panel title="API errors" note="Requests the provider refused or failed, by model" testId="panel-api-errors">
        <StackedBars
          buckets={data.buckets}
          bucketMs={data.query.bucketMs}
          series={data.errorsByBucket}
          format={formatCount}
          rangeTitle={ctx.rangeTitle}
          testId="chart-api-errors"
        />
        {data.apiErrors.length > 0 && (
          <ul className="mt-3 space-y-2" data-testid="list-api-errors">
            {data.apiErrors.map((e) => (
              <li key={`${e.model}-${e.status}`} className="min-w-0">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">
                    {e.model} · <span className="tabular-nums">{e.status}</span>
                  </span>
                  <span className="shrink-0 tabular-nums">{formatCount(e.count)}</span>
                </div>
                <div className="truncate text-xs text-muted-foreground" title={e.lastMessage ?? undefined}>
                  {[timeOfDay(e.lastMs), e.lastMessage].filter(Boolean).join(" · ")}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <PanelGrid>
        <Panel title="Retries" testId="panel-retries">
          <RankedBars
            rows={data.retries.map((r) => ({
              key: r.model,
              label: r.model,
              value: r.retries,
              display: formatCount(r.retries),
              sub: `over ${countOf(r.requests, "request")}`,
            }))}
            color={TONES.waiting}
            empty="No retries in this range"
            testId="list-retries"
          />
        </Panel>
        <Panel title="Tool failures" testId="panel-tool-failures">
          {data.toolFailures.length === 0 ? (
            <EmptyNote>No tool failed in this range</EmptyNote>
          ) : (
            <ul className="space-y-3" data-testid="list-tool-failures">
              {data.toolFailures.map((f) => (
                <li key={f.tool} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">{f.tool}</span>
                    <span className="shrink-0 tabular-nums text-destructive">
                      {formatCount(f.failures)} of {formatCount(f.calls)}
                    </span>
                  </div>
                  {f.recent.map((r) => (
                    <div
                      key={`${r.sessionId}-${r.timeMs}`}
                      className="truncate text-xs text-muted-foreground"
                      title={r.detail ?? undefined}
                    >
                      {[timeOfDay(r.timeMs), ctx.scoped ? null : sessionName(data.sessions, r.sessionId), r.detail]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="MCP servers" note="Connections, with failures in red" testId="panel-mcp-connections">
          <RankedBars
            rows={data.mcpServers.map((s) => ({
              key: s.server,
              label: s.server,
              value: s.attempts,
              display: s.failures
                ? `${formatCount(s.failures)} of ${formatCount(s.attempts)} failed`
                : `${formatCount(s.attempts)} connected`,
              sub: [
                s.p50Ms === null ? null : `typical ${formatMs(s.p50Ms)}`,
                s.maxMs === null ? null : `slowest ${formatMs(s.maxMs)}`,
                s.lastStatus ? `last ${s.lastStatus}` : null,
              ]
                .filter(Boolean)
                .join(" · "),
              segments: [
                { value: s.attempts - s.failures, color: TONES.added, label: "connected" },
                { value: s.failures, color: TONES.failure, label: "failed" },
              ],
            }))}
            empty="No MCP connections in this range"
            testId="list-mcp-connections"
          />
        </Panel>
        <Panel title="Cockpit's hooks" note="Time Claude Code spent running hooks" testId="panel-hooks">
          <RankedBars
            rows={data.hooks.map((h) => ({
              key: h.event,
              label: h.event,
              value: h.totalMs,
              display: formatMs(h.totalMs),
              sub: [
                countOf(h.runs, "run"),
                h.p90Ms === null ? null : `slowest tenth ${formatMs(h.p90Ms)}`,
                h.maxMs === null ? null : `slowest ${formatMs(h.maxMs)}`,
                h.blocking ? `${formatCount(h.blocking)} blocked` : null,
                h.errors ? countOf(h.errors, "error") : null,
              ]
                .filter(Boolean)
                .join(" · "),
            }))}
            color="var(--chart-6)"
            empty="No hooks ran in this range"
            testId="list-hooks"
          />
        </Panel>
      </PanelGrid>
    </div>
  );
}
