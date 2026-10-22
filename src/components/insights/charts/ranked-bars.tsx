"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { seriesColor } from "./kit";

export interface RankedRow {
  key: string;
  label: ReactNode;
  /** Plain text of the label, for its tooltip. */
  title?: string;
  value: number;
  display: string;
  sub?: ReactNode;
  /** Parts of the bar, in order; one plain bar without them. */
  segments?: Array<{ value: number; color: string; label: string }>;
  onClick?: () => void;
}

/**
 * Rows ranked by a value, each a label over a bar. The label sits above its
 * bar at every width, so long names and paths never squeeze the bar on a
 * phone. Rows past `limit` fold behind a button.
 */
export function RankedBars({
  rows,
  max,
  color = seriesColor(0),
  limit = 8,
  empty = "Nothing in this range",
  testId,
}: {
  rows: RankedRow[];
  max?: number;
  color?: string;
  limit?: number;
  empty?: string;
  testId?: string;
}) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return <p className="py-2 text-sm text-muted-foreground">{empty}</p>;
  const top = max ?? Math.max(...rows.map((r) => r.value), 0);
  const shown = all ? rows : rows.slice(0, limit);
  return (
    <div className="space-y-3" data-testid={testId}>
      {shown.map((row) => {
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate" title={row.title}>
                {row.label}
              </span>
              <span className="shrink-0 tabular-nums">{row.display}</span>
            </div>
            <div className="mt-1 flex h-2 overflow-hidden rounded-full bg-muted">
              {(row.segments ?? [{ value: row.value, color, label: "" }]).map((seg, i) => (
                <span
                  key={i}
                  className="h-full"
                  title={seg.label || undefined}
                  style={{ width: `${top > 0 ? (seg.value / top) * 100 : 0}%`, background: seg.color }}
                />
              ))}
            </div>
            {row.sub && <div className="mt-0.5 truncate text-xs text-muted-foreground">{row.sub}</div>}
          </>
        );
        return row.onClick ? (
          <button
            key={row.key}
            type="button"
            onClick={row.onClick}
            className="block w-full rounded text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {body}
          </button>
        ) : (
          <div key={row.key}>{body}</div>
        );
      })}
      {rows.length > limit && (
        <button type="button" onClick={() => setAll((v) => !v)} className="text-xs text-muted-foreground hover:text-foreground">
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}
