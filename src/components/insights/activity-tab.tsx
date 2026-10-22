"use client";

import { formatCount } from "@/lib/format-number";
import type { InsightsActivity } from "@/types";
import { Heatmap } from "./charts/heatmap";
import { TONES } from "./charts/kit";
import { RankedBars } from "./charts/ranked-bars";
import { StackedBars } from "./charts/stacked-bars";
import { StatTile } from "./charts/stat-tile";
import type { TabContext } from "./common";
import { Panel, PanelGrid } from "./panel";

export function ActivityTab({ data, ctx }: { data: InsightsActivity; ctx: TabContext }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Lines added" value={`+${formatCount(data.linesTotal.added)}`} testId="tile-lines-added" />
        <StatTile label="Lines removed" value={`−${formatCount(data.linesTotal.removed)}`} testId="tile-lines-removed" />
        <StatTile label="Commits" value={formatCount(data.commits)} sub="made by Claude" testId="tile-commits" />
        <StatTile label="Pull requests" value={formatCount(data.pullRequests)} sub="opened by Claude" testId="tile-prs" />
      </div>
      <PanelGrid>
        <Panel title="Lines changed" testId="panel-lines">
          <StackedBars
            buckets={data.buckets}
            bucketMs={data.query.bucketMs}
            series={data.lines}
            colors={{ added: TONES.added, removed: TONES.removed }}
            format={formatCount}
            rangeTitle={ctx.rangeTitle}
            testId="chart-lines"
          />
        </Panel>
        <Panel title="Prompts" testId="panel-prompts">
          <StackedBars
            buckets={data.buckets}
            bucketMs={data.query.bucketMs}
            series={data.prompts}
            format={formatCount}
            rangeTitle={ctx.rangeTitle}
            testId="chart-prompts"
          />
        </Panel>
        <Panel title="When you work" note="Prompts by weekday and hour" testId="panel-heatmap">
          <Heatmap data={data.heatmap} unit={["prompt", "prompts"]} testId="chart-heatmap" />
        </Panel>
        <Panel title="Edits by language" note="Accepted, with rejected in red" testId="panel-languages">
          <RankedBars
            rows={data.editsByLanguage.map((l) => ({
              key: l.language,
              label: l.language,
              value: l.accepted + l.rejected,
              display: `${formatCount(l.accepted)}${l.rejected ? ` · ${formatCount(l.rejected)} rejected` : ""}`,
              segments: [
                { value: l.accepted, color: TONES.added, label: "accepted" },
                { value: l.rejected, color: TONES.failure, label: "rejected" },
              ],
            }))}
            empty="No edits in this range"
            testId="list-languages"
          />
        </Panel>
      </PanelGrid>
    </div>
  );
}
