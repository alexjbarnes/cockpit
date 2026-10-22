"use client";

import { useState } from "react";
import { useWidth } from "./kit";
import { Readout } from "./readout";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Counts by weekday and hour. Days run down the side and hours across where
 * there is room; on a phone it turns, hours down and days across, so 24
 * columns never have to fit a phone.
 */
export function Heatmap({ data, unit, testId }: { data: number[][]; unit: [string, string]; testId?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [selected, setSelected] = useState<[number, number] | null>(null);
  const max = Math.max(1, ...data.flat());
  const total = data.flat().reduce((a, b) => a + b, 0);
  const wide = width >= 400;
  const count = (n: number) => `${n} ${n === 1 ? unit[0] : unit[1]}`;
  const cell = (day: number, hour: number) => {
    const v = data[day]?.[hour] ?? 0;
    const isSelected = selected?.[0] === day && selected?.[1] === hour;
    return (
      <button
        key={`${day}-${hour}`}
        type="button"
        aria-label={`${DAYS[day]} ${hour}:00, ${count(v)}`}
        onClick={() => setSelected(isSelected ? null : [day, hour])}
        onPointerEnter={(e) => e.pointerType === "mouse" && setSelected([day, hour])}
        className={`min-w-0 rounded-[3px] ${wide ? "aspect-square" : "h-4"} ${isSelected ? "ring-2 ring-foreground" : ""}`}
        style={{
          background:
            v === 0 ? "var(--color-muted)" : `color-mix(in oklch, var(--chart-1) ${Math.round(25 + (v / max) * 75)}%, transparent)`,
        }}
      />
    );
  };
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <div className="space-y-2" data-testid={testId}>
      <Readout
        title={selected ? `${DAYS[selected[0]]} ${String(selected[1]).padStart(2, "0")}:00` : "Every day and hour"}
        items={[]}
        total={selected ? count(data[selected[0]]?.[selected[1]] ?? 0) : count(total)}
      />
      <div ref={ref} onPointerLeave={(e) => e.pointerType === "mouse" && setSelected(null)}>
        {width > 0 &&
          (wide ? (
            <div
              className="grid gap-[3px] text-[10px] text-muted-foreground"
              style={{ gridTemplateColumns: "2.25rem repeat(24, minmax(0, 1fr))" }}
            >
              <span />
              {hours.map((h) => (
                <span key={h} className="text-center">
                  {h % 3 === 0 ? h : ""}
                </span>
              ))}
              {DAYS.map((day, d) => [
                <span key={day} className="self-center">
                  {day}
                </span>,
                ...hours.map((h) => cell(d, h)),
              ])}
            </div>
          ) : (
            <div
              className="grid gap-[3px] text-[10px] text-muted-foreground"
              style={{ gridTemplateColumns: "2rem repeat(7, minmax(0, 1fr))" }}
            >
              <span />
              {DAYS.map((day) => (
                <span key={day} className="text-center">
                  {day.slice(0, 2)}
                </span>
              ))}
              {hours.map((h) => [
                <span key={`h${h}`} className="self-center tabular-nums">
                  {h % 3 === 0 ? `${String(h).padStart(2, "0")}h` : ""}
                </span>,
                ...DAYS.map((_, d) => cell(d, h)),
              ])}
            </div>
          ))}
      </div>
    </div>
  );
}
