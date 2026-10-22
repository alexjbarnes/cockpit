"use client";

import { ArrowLeft, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { countOf, formatMs, formatTokens } from "@/lib/format-number";
import type { InsightsTimelineRow, InsightsTurn } from "@/types";
import { TONES, timeOfDay } from "./charts/kit";
import { BreakdownLegend, breakdownSegments, EmptyNote, moneyText, tokensText } from "./common";
import { Panel } from "./panel";

const ROW_COLOR: Record<InsightsTimelineRow["kind"], string> = {
  request: TONES.model,
  tool: TONES.tools,
  hook: "var(--chart-6)",
};

function rowDetails(row: InsightsTimelineRow): string[] {
  const out = [`${formatMs(row.endMs - row.startMs)}`];
  if (row.kind === "request") {
    if (row.ttftMs != null) out.push(`first token ${formatMs(row.ttftMs)}`);
    if (row.tokens) {
      out.push(
        `${formatTokens(row.tokens.input)} in`,
        `${formatTokens(row.tokens.output)} out`,
        `${formatTokens(row.tokens.cacheRead)} from cache`,
      );
      if (row.tokens.cacheWrite) out.push(`${formatTokens(row.tokens.cacheWrite)} cached`);
    }
    if (row.spend) out.push(moneyText(row.spend));
    if (row.attempt && row.attempt > 1) out.push(`attempt ${row.attempt}`);
  }
  if (row.kind === "tool") {
    const waited = row.segments.filter((s) => s.kind === "waiting").reduce((a, s) => a + (s.endMs - s.startMs), 0);
    if (waited > 0) out.push(`waited ${formatMs(waited)} for approval`);
  }
  if (row.success === false) out.push("failed");
  return out;
}

/**
 * One turn laid out on a time axis, like a browser's network panel: each
 * request and tool call is a bar where and as long as it ran. A tool's bar
 * shows its wait for approval (amber) before it ran (blue). Tap a row for its
 * numbers. Hooks are hidden until asked for, as there is one per tool call.
 */
export function TurnTimeline({ data, onBack }: { data: InsightsTurn; onBack: () => void }) {
  const [hooks, setHooks] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const turn = data.turn;
  const back = (
    <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2" data-testid="turn-back">
      <ArrowLeft className="mr-1 h-4 w-4" />
      Turns
    </Button>
  );
  if (!turn) {
    return (
      <div className="space-y-2">
        {back}
        <EmptyNote>This turn is no longer recorded.</EmptyNote>
      </div>
    );
  }
  const span = Math.max(1, turn.durationMs);
  const rows = turn.rows.filter((r) => hooks || r.kind !== "hook");
  const hookCount = turn.rows.length - turn.rows.filter((r) => r.kind !== "hook").length;
  const pos = (t: number) => Math.min(100, Math.max(0, ((t - turn.startMs) / span) * 100));
  const total = Math.max(1, turn.modelMs + turn.toolsMs + turn.waitingMs + turn.otherMs);
  return (
    <div className="space-y-4" data-testid="turn-timeline">
      {back}
      <Panel title={timeOfDay(turn.startMs)} note={`${formatMs(turn.durationMs)} · ${moneyText(turn.spend)} · ${tokensText(turn.tokens)}`}>
        <p className="whitespace-pre-wrap break-words text-sm">{turn.prompt ?? "(no prompt recorded)"}</p>
        <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-muted">
          {breakdownSegments(turn).map((s) => (
            <span key={s.label} title={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} />
          ))}
        </div>
        <div className="mt-1">
          <BreakdownLegend t={turn} />
        </div>
      </Panel>
      <Panel
        title="Timeline"
        note={`${countOf(turn.requests, "request")} · ${countOf(turn.toolCalls, "tool call")}`}
        action={
          hookCount > 0 ? (
            <Button variant="outline" size="sm" onClick={() => setHooks((v) => !v)} data-testid="toggle-hooks">
              {hooks ? "Hide hooks" : `Show hooks (${hookCount})`}
            </Button>
          ) : undefined
        }
      >
        <div className="mb-1 flex justify-between text-[10px] text-muted-foreground sm:ml-[13rem]">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span key={f} className="tabular-nums">
              {f === 0 ? "0" : formatMs(span * f)}
            </span>
          ))}
        </div>
        <ul className="space-y-1" data-testid="timeline-rows">
          {rows.map((row) => {
            const left = pos(row.startMs);
            const width = Math.max(0.6, pos(row.endMs) - left);
            const isOpen = open === row.id;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : row.id)}
                  aria-expanded={isOpen}
                  className="grid w-full grid-cols-1 items-center gap-x-3 gap-y-0.5 rounded px-1 py-1 text-left hover:bg-muted/50 sm:grid-cols-[12.5rem_1fr]"
                >
                  <span className="flex min-w-0 items-center gap-1 text-xs">
                    <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${isOpen ? "" : "-rotate-90"}`} />
                    <span className={`truncate ${row.success === false ? "text-destructive" : ""}`} title={row.detail ?? row.label}>
                      {row.label}
                      {row.detail && <span className="text-muted-foreground"> {row.detail}</span>}
                    </span>
                  </span>
                  <span className="relative block h-3 rounded-sm bg-muted/40">
                    <span
                      className="absolute top-0 h-full rounded-sm"
                      style={{
                        left: `${left}%`,
                        width: `${width}%`,
                        background: row.success === false ? TONES.failure : ROW_COLOR[row.kind],
                      }}
                    />
                    {row.segments.map((s) => (
                      <span
                        key={`${s.kind}-${s.startMs}`}
                        className="absolute top-0 h-full rounded-sm"
                        style={{
                          left: `${pos(s.startMs)}%`,
                          width: `${Math.max(0.4, pos(s.endMs) - pos(s.startMs))}%`,
                          background: s.kind === "waiting" ? TONES.waiting : TONES.tools,
                        }}
                      />
                    ))}
                    {row.kind === "request" && row.ttftMs != null && (
                      <span className="absolute top-0 h-full w-px bg-foreground/70" style={{ left: `${pos(row.startMs + row.ttftMs)}%` }} />
                    )}
                  </span>
                </button>
                {isOpen && (
                  <div className="ml-5 pb-2 text-xs text-muted-foreground sm:ml-[13.5rem]">
                    {row.detail && <div className="break-all font-mono text-foreground">{row.detail}</div>}
                    <div>{rowDetails(row).join(" · ")}</div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Panel>
    </div>
  );
}
