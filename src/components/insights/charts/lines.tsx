"use client";

import { useState } from "react";
import { nearestIndex, niceMax, tickIndexes } from "@/lib/insights/chart";
import { seriesColor, TickLabel, useWidth } from "./kit";
import { Readout } from "./readout";

const AXIS = 18;
const PAD = 4;

export interface LineSeries {
  key: string;
  label: string;
  values: Array<number | null>;
  color?: string;
}

/**
 * Lines over shared x positions (bucket starts, or the times of points), with
 * gaps where a value is missing. `marks` flags positions to draw a marker at,
 * such as a compaction. Tap or hover to read the nearest point.
 */
export function Lines({
  xs,
  series,
  format,
  tick,
  title,
  rangeTitle,
  marks,
  markLabel,
  yMax,
  height = 168,
  testId,
}: {
  xs: number[];
  series: LineSeries[];
  format: (v: number) => string;
  tick: (x: number) => string;
  /** The readout's title for a selected position. */
  title: (x: number) => string;
  rangeTitle: string;
  marks?: boolean[];
  markLabel?: string;
  yMax?: number;
  height?: number;
  testId?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [selected, setSelected] = useState<number | null>(null);
  const n = xs.length;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const top = yMax ?? niceMax(Math.max(0, ...all));
  const plotH = height - AXIS;
  const x0 = xs[0] ?? 0;
  const span = n > 1 ? xs[n - 1] - x0 : 1;
  const px = (x: number) => (n > 1 ? PAD + ((x - x0) / span) * (width - 2 * PAD) : width / 2);
  const py = (v: number) => plotH - (Math.min(v, top) / top) * (plotH - 4);
  const color = (s: LineSeries, i: number) => s.color ?? seriesColor(i);

  const path = (values: Array<number | null>) => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${px(xs[i]).toFixed(1)},${py(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left - PAD) / Math.max(1, rect.width - 2 * PAD);
    setSelected(nearestIndex(xs, x0 + frac * span));
  };

  const latest = (s: LineSeries) => [...s.values].reverse().find((v) => v !== null) ?? null;
  const items = series
    .map((s, i) => {
      const v = selected === null ? latest(s) : s.values[selected];
      return v === null || v === undefined ? null : { key: s.key, label: s.label, color: color(s, i), value: format(v) };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return (
    <div className="space-y-2" data-testid={testId}>
      <Readout
        title={selected === null ? rangeTitle : `${title(xs[selected])}${marks?.[selected] && markLabel ? ` · ${markLabel}` : ""}`}
        items={items.slice(0, 8)}
        testId={testId ? `${testId}-readout` : undefined}
      />
      <div ref={ref} className="w-full">
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={rangeTitle}
            tabIndex={0}
            className="block touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            onPointerMove={(e) => e.pointerType === "mouse" && pick(e)}
            onPointerDown={pick}
            onPointerLeave={(e) => e.pointerType === "mouse" && setSelected(null)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") setSelected((s) => Math.min(n - 1, (s ?? -1) + 1));
              else if (e.key === "ArrowLeft") setSelected((s) => Math.max(0, (s ?? n) - 1));
              else if (e.key === "Escape") setSelected(null);
              else return;
              e.preventDefault();
            }}
          >
            {[0.5, 1].map((f) => (
              <line key={f} x1={0} x2={width} y1={py(top * f)} y2={py(top * f)} className="stroke-border" strokeDasharray="2 3" />
            ))}
            <line x1={0} x2={width} y1={plotH} y2={plotH} className="stroke-border" />
            <text x={2} y={10} className="fill-muted-foreground text-[10px]">
              {format(top)}
            </text>
            {marks?.map((m, i) =>
              m ? (
                <line
                  key={xs[i]}
                  x1={px(xs[i])}
                  x2={px(xs[i])}
                  y1={0}
                  y2={plotH}
                  style={{ stroke: "var(--chart-4)" }}
                  strokeDasharray="3 2"
                />
              ) : null,
            )}
            {selected !== null && (
              <line x1={px(xs[selected])} x2={px(xs[selected])} y1={0} y2={plotH} className="stroke-muted-foreground" />
            )}
            {series.map((s, i) => (
              <g key={s.key} style={{ color: color(s, i) }}>
                <path d={path(s.values)} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {s.values.map((v, j) =>
                  v !== null && (n <= 40 || j === selected) ? (
                    <circle key={xs[j]} cx={px(xs[j])} cy={py(v)} r={j === selected ? 3.5 : 2} fill="currentColor" />
                  ) : null,
                )}
              </g>
            ))}
            {tickIndexes(n, width, 64).map((i) => (
              <TickLabel key={i} x={px(xs[i])} y={height - 4} width={width}>
                {tick(xs[i])}
              </TickLabel>
            ))}
            {all.length === 0 && (
              <text x={width / 2} y={plotH / 2} textAnchor="middle" className="fill-muted-foreground text-xs">
                Nothing in this range
              </text>
            )}
          </svg>
        )}
      </div>
    </div>
  );
}
