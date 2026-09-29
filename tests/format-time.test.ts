import { describe, expect, it } from "vitest";
import { formatDuration, formatMessageTime, formatWorkedFor } from "@/lib/format-time";

// Fixed reference "now": Wednesday 2026-07-15 14:30 local time.
const NOW = new Date(2026, 6, 15, 14, 30, 0).getTime();
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi, 0).getTime();
const hhmm = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

describe("formatMessageTime", () => {
  it("shows time only for earlier today", () => {
    const ts = at(2026, 6, 15, 9, 5);
    expect(formatMessageTime(ts, NOW)).toBe(hhmm(ts));
  });

  it("shows time only for later the same day (clock skew / future)", () => {
    const ts = at(2026, 6, 15, 23, 59);
    expect(formatMessageTime(ts, NOW)).toBe(hhmm(ts));
  });

  it("prefixes 'Yesterday'", () => {
    const ts = at(2026, 6, 14, 22, 27);
    expect(formatMessageTime(ts, NOW)).toBe(`Yesterday ${hhmm(ts)}`);
  });

  it("uses the weekday within the last week", () => {
    const ts = at(2026, 6, 12, 22, 27); // Sunday
    expect(formatMessageTime(ts, NOW)).toBe(`Sunday ${hhmm(ts)}`);
  });

  it("uses day + month beyond a week, same year", () => {
    const ts = at(2026, 5, 3, 8, 15); // 3 Jun 2026
    const out = formatMessageTime(ts, NOW);
    expect(out).toContain("Jun");
    expect(out).not.toContain("2026");
    expect(out.endsWith(hhmm(ts))).toBe(true);
  });

  it("includes the year for a different year", () => {
    const ts = at(2025, 0, 3, 8, 15); // 3 Jan 2025
    expect(formatMessageTime(ts, NOW)).toContain("2025");
  });
});

describe("formatWorkedFor", () => {
  it("rounds sub-second up to 1s", () => {
    expect(formatWorkedFor(200)).toBe("Worked for 1s");
  });

  it("shows whole seconds under a minute", () => {
    expect(formatWorkedFor(18_000)).toBe("Worked for 18s");
  });

  it("shows minutes and seconds", () => {
    expect(formatWorkedFor(125_000)).toBe("Worked for 2m 5s");
  });

  it("drops the seconds at a whole minute", () => {
    expect(formatWorkedFor(120_000)).toBe("Worked for 2m");
  });

  it("shows hours and minutes", () => {
    expect(formatWorkedFor(3_720_000)).toBe("Worked for 1h 2m");
  });

  it("drops the minutes at a whole hour", () => {
    expect(formatWorkedFor(3_600_000)).toBe("Worked for 1h");
  });
});

// Shared by the finished-turn label and the live counter beside the spinner, so
// a turn must not change format the moment it ends.
describe("formatDuration", () => {
  it("rounds a just-started turn up to 1s rather than showing 0s", () => {
    expect(formatDuration(0)).toBe("1s");
    expect(formatDuration(400)).toBe("1s");
  });

  it("counts in seconds under a minute", () => {
    expect(formatDuration(18_000)).toBe("18s");
    expect(formatDuration(59_400)).toBe("59s");
  });

  it("switches to minutes and drops a zero seconds remainder", () => {
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("switches to hours and drops a zero minutes remainder", () => {
    expect(formatDuration(3_840_000)).toBe("1h 4m");
    expect(formatDuration(3_600_000)).toBe("1h");
  });

  it("is the same string formatWorkedFor wraps, so the counter does not jump on turn end", () => {
    expect(formatWorkedFor(125_000)).toBe(`Worked for ${formatDuration(125_000)}`);
  });
});
