"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

/** An axis label that stays inside the chart: anchored at its start near the
 *  left edge and at its end near the right, centred elsewhere. */
export function TickLabel({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const anchor = x < 24 ? "start" : x > width - 24 ? "end" : "middle";
  const at = anchor === "start" ? Math.max(0, x - 4) : anchor === "end" ? Math.min(width, x + 4) : x;
  return (
    <text x={at} y={y} textAnchor={anchor} className="fill-muted-foreground text-[10px]">
      {children}
    </text>
  );
}

/** A series colour by position. The variables are defined for both themes in
 *  globals.css, so a chart follows the theme without re-rendering. */
export function seriesColor(i: number): string {
  return `var(--chart-${(i % 8) + 1})`;
}

/** Colours that mean the same thing on every chart. */
export const TONES = {
  model: "var(--chart-2)",
  tools: "var(--chart-1)",
  waiting: "var(--chart-4)",
  other: "var(--color-muted-foreground)",
  failure: "var(--color-destructive)",
  added: "var(--chart-3)",
  removed: "var(--chart-5)",
} as const;

/** The element's content width, kept current as it resizes. Charts draw at
 *  their real width rather than scaling a fixed viewBox, so their text stays
 *  the same size on a phone as on a desktop. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const HOUR = 60 * 60 * 1000;

/** A bucket's tick label: "14:00" for hours, "Tue 21" for a week of days,
 *  "21 Oct" for a month. */
export function bucketTick(t: number, bucketMs: number, count: number): string {
  const d = new Date(t);
  if (bucketMs <= HOUR) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (count <= 7) return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** A bucket's full name, for the readout: "Tue 21 Oct, 14:00" or "Tue 21 Oct". */
export function bucketTitle(t: number, bucketMs: number): string {
  const d = new Date(t);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return bucketMs <= HOUR ? `${day}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : day;
}

/** "14:03" today, "Tue 21 Oct, 14:03" otherwise. */
export function timeOfDay(t: number, now = Date.now()): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (new Date(now).toDateString() === d.toDateString()) return time;
  return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}
