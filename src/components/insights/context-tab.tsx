"use client";

import { formatCount, formatTokens } from "@/lib/format-number";
import type { InsightsContext } from "@/types";
import { TONES, timeOfDay } from "./charts/kit";
import { Lines } from "./charts/lines";
import { StatTile } from "./charts/stat-tile";
import type { TabContext } from "./common";
import { Panel } from "./panel";

/** How full the session's context was at each request, and where compaction cut it back. */
export function ContextTab({ data, ctx }: { data: InsightsContext; ctx: TabContext }) {
  const points = data.points;
  const peak = Math.max(0, ...points.map((p) => p.tokens));
  const compactions = points.filter((p) => p.compaction).length;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Latest" value={points.length ? formatTokens(points[points.length - 1].tokens) : "–"} sub="tokens of context" />
        <StatTile label="Peak" value={points.length ? formatTokens(peak) : "–"} sub="tokens of context" />
        <StatTile label="Requests" value={formatCount(points.length)} sub="in the conversation" />
        <StatTile label="Compactions" value={formatCount(compactions)} />
      </div>
      <Panel title="Context per request" note="What each request sent: input, cache reads and cache writes" testId="panel-context">
        <Lines
          xs={points.map((p) => p.timeMs)}
          series={[{ key: "context", label: "Context", values: points.map((p) => p.tokens), color: TONES.model }]}
          marks={points.map((p) => p.compaction)}
          markLabel="compaction"
          format={formatTokens}
          tick={(x) => timeOfDay(x)}
          title={(x) => timeOfDay(x)}
          rangeTitle={`${ctx.rangeTitle}, latest`}
          testId="chart-context"
        />
      </Panel>
    </div>
  );
}
