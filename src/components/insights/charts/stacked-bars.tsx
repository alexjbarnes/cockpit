"use client";

import { useState } from "react";
import { niceMax, slotAt, tickIndexes } from "@/lib/insights/chart";
import type { InsightsSeries } from "@/types";
import { bucketTick, bucketTitle, seriesColor, TickLabel, useWidth } from "./kit";
import { Readout } from "./readout";

const AXIS = 18;

/**
 * Bars per time bucket, each stacked by series. Tap or hover a bar to read its
 * values above the chart; arrow keys move along when it has focus.
 */
export function StackedBars({
  buckets,
  bucketMs,
  series,
  format,
  colors,
  height = 168,
  rangeTitle,
  testId,
}: {
  buckets: number[];
  bucketMs: number;
  series: InsightsSeries[];
  format: (v: number) => string;
  /** A colour per series key; position colours otherwise. */
  colors?: Record<string, string>;
  height?: number;
  rangeTitle: string;
  testId?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [selected, setSelected] = useState<number | null>(null);
  const n = buckets.length;
  const color = (key: string, i: number) => colors?.[key] ?? seriesColor(i);
  const totals = buckets.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const grand = totals.reduce((a, b) => a + b, 0);
  const top = niceMax(Math.max(0, ...totals));
  const plotH = height - AXIS;
  const slot = n ? width / n : 0;
  const barW = Math.max(1, Math.min(28, slot * 0.7));

  const items =
    selected === null
      ? series.map((s, i) => ({
          key: s.key,
          label: s.label,
          color: color(s.key, i),
          value: format(s.values.reduce<number>((a, v) => a + (v ?? 0), 0)),
        }))
      : series
          .map((s, i) => ({ key: s.key, label: s.label, color: color(s.key, i), raw: s.values[selected] ?? 0 }))
          .filter((s) => s.raw > 0)
          .map(({ raw, ...s }) => ({ ...s, value: format(raw) }));

  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setSelected(slotAt(e.clientX - rect.left, rect.width, n));
  };

  return (
    <div className="space-y-2" data-testid={testId}>
      <Readout
        title={selected === null ? rangeTitle : bucketTitle(buckets[selected], bucketMs)}
        items={items.slice(0, 8)}
        total={format(selected === null ? grand : totals[selected])}
        testId={testId ? `${testId}-readout` : undefined}
      />
      <div ref={ref} className="w-full">
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`${rangeTitle}: ${format(grand)}`}
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
              <line
                key={f}
                x1={0}
                x2={width}
                y1={plotH - plotH * f}
                y2={plotH - plotH * f}
                className="stroke-border"
                strokeDasharray="2 3"
              />
            ))}
            <line x1={0} x2={width} y1={plotH} y2={plotH} className="stroke-border" />
            <text x={2} y={10} className="fill-muted-foreground text-[10px]">
              {format(top)}
            </text>
            {selected !== null && <rect x={selected * slot} y={0} width={slot} height={plotH} className="fill-muted" opacity={0.6} />}
            {buckets.map((t, i) => {
              let y = plotH;
              return (
                <g key={t}>
                  {series.map((s, si) => {
                    const v = s.values[i] ?? 0;
                    if (v <= 0) return null;
                    const h = Math.max(1, (v / top) * plotH);
                    y -= h;
                    return (
                      <rect
                        key={s.key}
                        x={i * slot + (slot - barW) / 2}
                        y={y}
                        width={barW}
                        height={h}
                        rx={1.5}
                        style={{ fill: color(s.key, si) }}
                      />
                    );
                  })}
                </g>
              );
            })}
            {tickIndexes(n, width).map((i) => (
              <TickLabel key={i} x={i * slot + slot / 2} y={height - 4} width={width}>
                {bucketTick(buckets[i], bucketMs, n)}
              </TickLabel>
            ))}
            {grand === 0 && (
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
