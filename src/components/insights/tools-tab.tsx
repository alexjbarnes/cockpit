"use client";

import { countOf, formatCount, formatMs } from "@/lib/format-number";
import type { InsightsTools } from "@/types";
import { TONES, timeOfDay } from "./charts/kit";
import { RankedBars } from "./charts/ranked-bars";
import { StatTile } from "./charts/stat-tile";
import { EmptyNote, sessionName, type TabContext } from "./common";
import { Panel, PanelGrid } from "./panel";

const ANSWERERS: Record<string, string> = {
  you: "You",
  bypass: "Bypass",
  cockpit: "Cockpit's rules",
  terminal: "In the terminal",
  interrupted: "Interrupted",
  ended: "Session ended",
};

function timing(p50: number | null, p90: number | null, total: number): string {
  return [
    p50 === null ? null : `typical ${formatMs(p50)}`,
    p90 === null ? null : `slowest tenth ${formatMs(p90)}`,
    `${formatMs(total)} in all`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Calls as a bar, its failed part in red. */
function callSegments(calls: number, failures: number) {
  return [
    { value: calls - failures, color: TONES.tools, label: `${formatCount(calls - failures)} succeeded` },
    { value: failures, color: TONES.failure, label: `${formatCount(failures)} failed` },
  ];
}

export function ToolsTab({ data, ctx }: { data: InsightsTools; ctx: TabContext }) {
  const w = data.waiting;
  const answered = Object.entries(w.answeredBy).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-4">
      <Panel title="Tools" note="Calls, with failures in red" testId="panel-tools">
        <RankedBars
          rows={data.tools.map((t) => ({
            key: t.name,
            label: t.name,
            title: t.name,
            value: t.calls,
            display: `${formatCount(t.calls)}${t.failures ? ` · ${formatCount(t.failures)} failed` : ""}`,
            sub: timing(t.p50Ms, t.p90Ms, t.totalMs),
            segments: callSegments(t.calls, t.failures),
          }))}
          testId="list-tools"
        />
      </Panel>
      <PanelGrid>
        <Panel title="Bash, by program" testId="panel-programs">
          <RankedBars
            rows={data.programs.map((p) => ({
              key: p.name,
              label: p.name,
              value: p.calls,
              display: formatCount(p.calls),
              sub: `${formatMs(p.totalMs)} in all${p.p90Ms === null ? "" : ` · slowest tenth ${formatMs(p.p90Ms)}`}`,
              segments: callSegments(p.calls, p.failures),
            }))}
            empty="No Bash commands in this range"
            testId="list-programs"
          />
        </Panel>
        <Panel title="Slowest commands" testId="panel-slow-commands">
          {data.slowestCommands.length === 0 ? (
            <EmptyNote>No Bash commands in this range</EmptyNote>
          ) : (
            <ul className="space-y-2" data-testid="list-slow-commands">
              {data.slowestCommands.map((c) => (
                <li key={`${c.sessionId}-${c.timeMs}`} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <code className="min-w-0 truncate text-xs" title={c.command}>
                      {c.command}
                    </code>
                    <span className={`shrink-0 text-sm tabular-nums ${c.success === false ? "text-destructive" : ""}`}>
                      {formatMs(c.durationMs)}
                    </span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {[ctx.scoped ? null : sessionName(data.sessions, c.sessionId), timeOfDay(c.timeMs)].filter(Boolean).join(" · ")}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="MCP servers" testId="panel-mcp-tools">
          <RankedBars
            rows={data.mcpServers.map((s) => ({
              key: s.server,
              label: s.server,
              value: s.calls,
              display: formatCount(s.calls),
              sub: s.tools
                .slice(0, 3)
                .map((t) => `${t.name} ${formatCount(t.calls)}`)
                .join(" · "),
              segments: callSegments(s.calls, s.failures),
            }))}
            empty="No MCP tools in this range"
            testId="list-mcp-tools"
          />
        </Panel>
        <Panel title="Files touched most" testId="panel-files">
          <RankedBars
            rows={data.files.map((f) => ({
              key: f.path,
              // Cut from the start, so a long path keeps its file name.
              label: (
                <span dir="rtl" className="block truncate text-left">
                  <bdi>{f.path}</bdi>
                </span>
              ),
              title: f.path,
              value: f.touches,
              display: formatCount(f.touches),
              sub: f.edits ? countOf(f.edits, "edit") : "read only",
            }))}
            empty="No files touched in this range"
            testId="list-files"
          />
        </Panel>
      </PanelGrid>
      <Panel title="Waiting on you" note="Permission prompts and questions, and who answered them" testId="panel-waiting">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="Time waiting on you" value={w.totalMs > 0 ? formatMs(w.totalMs) : "0s"} />
          <StatTile label="You allowed" value={formatCount(w.allowed)} sub={`${formatCount(w.denied)} denied`} />
          <StatTile label="Rules allowed" value={formatCount(w.rulesApproved)} sub="without asking" />
          <StatTile
            label="Answered"
            value={formatCount(answered.reduce((a, [, n]) => a + n, 0))}
            sub={answered.map(([who, n]) => `${ANSWERERS[who] ?? who} ${formatCount(n)}`).join(" · ") || "none recorded"}
          />
        </div>
        <div className="mt-4">
          <RankedBars
            rows={w.byTool.map((t) => ({
              key: t.tool,
              label: t.tool,
              value: t.totalMs,
              display: formatMs(t.totalMs),
              sub: `${countOf(t.waits, "prompt")}${t.p50Ms === null ? "" : ` · typical ${formatMs(t.p50Ms)}`}`,
            }))}
            color={TONES.waiting}
            empty="Nothing waited on you in this range"
            testId="list-waiting"
          />
        </div>
      </Panel>
    </div>
  );
}
