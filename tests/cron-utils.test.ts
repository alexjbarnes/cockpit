import { describe, expect, it } from "vitest";
import {
  describeAllSchedules,
  describeSchedule,
  findMissedRun,
  getJobSchedules,
  getNextRunTime,
  getNextRunTimeAny,
  matchesCron,
  scheduleToCron,
  simpleScheduleToCron,
} from "@/server/cron-utils";
import type { JobSchedule, SimpleSchedule } from "@/types";

describe("matchesCron", () => {
  it("matches exact minute and hour", () => {
    const date = new Date(2026, 4, 17, 14, 30, 0);
    expect(matchesCron("30 14 * * *", date)).toBe(true);
  });

  it("rejects wrong minute", () => {
    const date = new Date(2026, 4, 17, 14, 31, 0);
    expect(matchesCron("30 14 * * *", date)).toBe(false);
  });

  it("matches wildcard fields", () => {
    const date = new Date(2026, 4, 17, 14, 0, 0);
    expect(matchesCron("0 * * * *", date)).toBe(true);
  });

  it("matches day of week", () => {
    const sunday = new Date(2026, 4, 17, 0, 0, 0); // May 17, 2026 is Sunday
    expect(matchesCron("0 0 * * 0", sunday)).toBe(true);
    expect(matchesCron("0 0 * * 1", sunday)).toBe(false);
  });

  it("matches day of month", () => {
    const date = new Date(2026, 4, 1, 9, 0, 0);
    expect(matchesCron("0 9 1 * *", date)).toBe(true);
    expect(matchesCron("0 9 2 * *", date)).toBe(false);
  });

  it("matches month field", () => {
    const may = new Date(2026, 4, 17, 0, 0, 0);
    expect(matchesCron("0 0 * 5 *", may)).toBe(true);
    expect(matchesCron("0 0 * 6 *", may)).toBe(false);
  });

  it("handles comma-separated values", () => {
    const date = new Date(2026, 4, 17, 14, 15, 0);
    expect(matchesCron("15,30,45 * * * *", date)).toBe(true);
    expect(matchesCron("0,30,45 * * * *", date)).toBe(false);
  });

  it("handles ranges", () => {
    const date = new Date(2026, 4, 17, 14, 15, 0);
    expect(matchesCron("10-20 * * * *", date)).toBe(true);
    expect(matchesCron("20-30 * * * *", date)).toBe(false);
  });

  it("handles step values", () => {
    const date = new Date(2026, 4, 17, 14, 15, 0);
    expect(matchesCron("*/15 * * * *", date)).toBe(true);
    expect(matchesCron("*/7 * * * *", date)).toBe(false);
  });

  it("handles range with step", () => {
    const date = new Date(2026, 4, 17, 14, 10, 0);
    expect(matchesCron("0-20/5 * * * *", date)).toBe(true);
    expect(matchesCron("0-20/3 * * * *", date)).toBe(false);
  });

  it("throws on invalid cron expression", () => {
    expect(() => matchesCron("* * *", new Date())).toThrow("expected 5 fields");
  });
});

describe("simpleScheduleToCron", () => {
  it("converts hourly schedule", () => {
    const s: SimpleSchedule = { type: "simple", frequency: "hourly", time: "00:15" };
    expect(simpleScheduleToCron(s)).toBe("15 * * * *");
  });

  it("converts daily schedule", () => {
    const s: SimpleSchedule = { type: "simple", frequency: "daily", time: "09:30" };
    expect(simpleScheduleToCron(s)).toBe("30 9 * * *");
  });

  it("converts weekly schedule", () => {
    const s: SimpleSchedule = { type: "simple", frequency: "weekly", time: "10:00", dayOfWeek: 3 };
    expect(simpleScheduleToCron(s)).toBe("0 10 * * 3");
  });

  it("converts monthly schedule", () => {
    const s: SimpleSchedule = { type: "simple", frequency: "monthly", time: "08:00", dayOfMonth: 15 };
    expect(simpleScheduleToCron(s)).toBe("0 8 15 * *");
  });

  it("defaults dayOfWeek to 0 when not specified", () => {
    const s: SimpleSchedule = { type: "simple", frequency: "weekly", time: "12:00" };
    expect(simpleScheduleToCron(s)).toBe("0 12 * * 0");
  });

  it("defaults dayOfMonth to 1 when not specified", () => {
    const s: SimpleSchedule = { type: "simple", frequency: "monthly", time: "06:00" };
    expect(simpleScheduleToCron(s)).toBe("0 6 1 * *");
  });

  it("defaults time to 00:00 when not specified", () => {
    const s: SimpleSchedule = { type: "simple", frequency: "daily" };
    expect(simpleScheduleToCron(s)).toBe("0 0 * * *");
  });
});

describe("scheduleToCron", () => {
  it("passes through cron expressions", () => {
    const s: JobSchedule = { type: "cron", expression: "5 4 * * *" };
    expect(scheduleToCron(s)).toBe("5 4 * * *");
  });

  it("converts simple schedules", () => {
    const s: JobSchedule = { type: "simple", frequency: "daily", time: "09:00" };
    expect(scheduleToCron(s)).toBe("0 9 * * *");
  });
});

describe("describeSchedule", () => {
  it("describes cron expression", () => {
    expect(describeSchedule({ type: "cron", expression: "*/5 * * * *" })).toBe("cron: */5 * * * *");
  });

  it("describes hourly", () => {
    expect(describeSchedule({ type: "simple", frequency: "hourly", time: "00:30" })).toBe("Every hour at :30");
  });

  it("describes daily", () => {
    expect(describeSchedule({ type: "simple", frequency: "daily", time: "09:00" })).toBe("Daily at 09:00");
  });

  it("describes weekly", () => {
    expect(describeSchedule({ type: "simple", frequency: "weekly", time: "10:00", dayOfWeek: 1 })).toBe("Weekly on Monday at 10:00");
  });

  it("describes monthly", () => {
    expect(describeSchedule({ type: "simple", frequency: "monthly", time: "08:00", dayOfMonth: 15 })).toBe("Monthly on day 15 at 08:00");
  });

  it("defaults time to 00:00 for hourly description", () => {
    expect(describeSchedule({ type: "simple", frequency: "hourly" })).toBe("Every hour at :00");
  });
});

describe("getNextRunTime", () => {
  it("finds next matching minute", () => {
    const after = new Date(2026, 4, 17, 14, 0, 0);
    const next = getNextRunTime({ type: "cron", expression: "30 14 * * *" }, after);
    expect(next.getHours()).toBe(14);
    expect(next.getMinutes()).toBe(30);
  });

  it("wraps to next day when no match today", () => {
    const after = new Date(2026, 4, 17, 14, 31, 0);
    const next = getNextRunTime({ type: "cron", expression: "30 14 * * *" }, after);
    expect(next.getDate()).toBe(18);
    expect(next.getHours()).toBe(14);
    expect(next.getMinutes()).toBe(30);
  });

  it("finds next occurrence for daily simple schedule", () => {
    const after = new Date(2026, 4, 17, 10, 0, 0);
    const next = getNextRunTime({ type: "simple", frequency: "daily", time: "09:00" }, after);
    expect(next.getDate()).toBe(18);
    expect(next.getHours()).toBe(9);
  });
});

describe("findMissedRun", () => {
  it("returns true when a cron match exists between lastFired and now", () => {
    const lastFired = new Date(2026, 4, 17, 8, 0, 0);
    const now = new Date(2026, 4, 17, 10, 0, 0);
    expect(findMissedRun("0 9 * * *", lastFired, now)).toBe(true);
  });

  it("returns false when no cron match in window", () => {
    const lastFired = new Date(2026, 4, 17, 9, 30, 0);
    const now = new Date(2026, 4, 17, 10, 0, 0);
    expect(findMissedRun("0 9 * * *", lastFired, now)).toBe(false);
  });

  it("returns false when lastFired and now are same minute", () => {
    const lastFired = new Date(2026, 4, 17, 9, 0, 0);
    const now = new Date(2026, 4, 17, 9, 0, 30);
    expect(findMissedRun("0 9 * * *", lastFired, now)).toBe(false);
  });

  it("caps lookback to 24 hours", () => {
    const lastFired = new Date(2026, 4, 15, 9, 0, 0);
    const now = new Date(2026, 4, 17, 10, 0, 0);
    expect(findMissedRun("0 9 * * *", lastFired, now)).toBe(true);
  });
});

describe("getJobSchedules", () => {
  it("returns schedules array when present and non-empty", () => {
    const s1: JobSchedule = { type: "simple", frequency: "daily", time: "09:00" };
    const s2: JobSchedule = { type: "cron", expression: "0 18 * * *" };
    const result = getJobSchedules({ schedule: s1, schedules: [s1, s2] });
    expect(result).toHaveLength(2);
  });

  it("falls back to single schedule when schedules is empty", () => {
    const s: JobSchedule = { type: "simple", frequency: "daily", time: "09:00" };
    const result = getJobSchedules({ schedule: s, schedules: [] });
    expect(result).toEqual([s]);
  });

  it("falls back to single schedule when schedules is undefined", () => {
    const s: JobSchedule = { type: "simple", frequency: "daily", time: "09:00" };
    const result = getJobSchedules({ schedule: s });
    expect(result).toEqual([s]);
  });
});

describe("describeAllSchedules", () => {
  it("joins multiple schedule descriptions with semicolons", () => {
    const schedules: JobSchedule[] = [
      { type: "simple", frequency: "daily", time: "09:00" },
      { type: "cron", expression: "0 18 * * *" },
    ];
    expect(describeAllSchedules(schedules)).toBe("Daily at 09:00; cron: 0 18 * * *");
  });
});

describe("getNextRunTimeAny", () => {
  it("returns the earliest next run across multiple schedules", () => {
    const after = new Date(2026, 4, 17, 10, 0, 0);
    const schedules: JobSchedule[] = [
      { type: "simple", frequency: "daily", time: "15:00" },
      { type: "simple", frequency: "daily", time: "12:00" },
    ];
    const next = getNextRunTimeAny(schedules, after);
    expect(next.getHours()).toBe(12);
  });

  it("returns fallback when no schedules provided", () => {
    const after = new Date(2026, 4, 17, 10, 0, 0);
    const next = getNextRunTimeAny([], after);
    expect(next.getTime()).toBe(after.getTime() + 86400000);
  });
});
