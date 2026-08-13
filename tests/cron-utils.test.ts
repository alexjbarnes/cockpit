import { describe, expect, it } from "vitest";
import {
  assertValidCronExpression,
  describeAllSchedules,
  describeSchedule,
  findMissedRun,
  getJobSchedules,
  getNextRunTime,
  getNextRunTimeAny,
  hasTimeBasedSchedule,
  matchesCron,
  scheduleToCron,
  simpleScheduleToCron,
} from "@/server/cron-utils";
import type { JobSchedule, SimpleSchedule } from "@/types";

describe("assertValidCronExpression", () => {
  it("accepts well-formed expressions, including steps, ranges and lists", () => {
    for (const expr of ["0 9 * * 1", "*/15 * * * *", "30 6 1 * *", "0 8-18/2 * * 1-5", "0,30 9,17 * * *"]) {
      expect(() => assertValidCronExpression(expr), expr).not.toThrow();
    }
  });

  it("rejects the garbage parseCron silently turns into NaN (job would never fire)", () => {
    for (const expr of ["banana * * * *", "* pear * * *", "1-x * * * *"]) {
      expect(() => assertValidCronExpression(expr), expr).toThrow(/malformed|out of range/);
    }
  });

  it("rejects out-of-range field values", () => {
    for (const expr of ["61 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 7"]) {
      expect(() => assertValidCronExpression(expr), expr).toThrow(/out of range/);
    }
  });

  it("rejects the wrong number of fields", () => {
    for (const expr of ["* * *", "* * * * * *", ""]) {
      expect(() => assertValidCronExpression(expr), expr).toThrow(/expected 5 fields/);
    }
  });
});

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

  it("uses OR when both day-of-month and day-of-week are non-wildcard", () => {
    // Standard cron: when both DOM and DOW are specified, match if EITHER is true
    // "0 9 15 * 2" = "at 9:00 on the 15th OR on Tuesdays"

    // May 19, 2026 is Tuesday - should match via DOW even though not the 15th
    const tuesday = new Date(2026, 4, 19, 9, 0, 0);
    expect(matchesCron("0 9 15 * 2", tuesday)).toBe(true);

    // May 15, 2026 is Friday - should match via DOM even though not Tuesday
    const fifteenth = new Date(2026, 4, 15, 9, 0, 0);
    expect(matchesCron("0 9 15 * 2", fifteenth)).toBe(true);

    // May 14, 2026 is Thursday, not the 15th - should NOT match
    const neither = new Date(2026, 4, 14, 9, 0, 0);
    expect(matchesCron("0 9 15 * 2", neither)).toBe(false);
  });

  it("still requires day-of-month when day-of-week is wildcard", () => {
    const fifteenth = new Date(2026, 4, 15, 9, 0, 0);
    expect(matchesCron("0 9 15 * *", fifteenth)).toBe(true);

    const sixteenth = new Date(2026, 4, 16, 9, 0, 0);
    expect(matchesCron("0 9 15 * *", sixteenth)).toBe(false);
  });

  it("still requires day-of-week when day-of-month is wildcard", () => {
    // May 19, 2026 is Tuesday
    const tuesday = new Date(2026, 4, 19, 9, 0, 0);
    expect(matchesCron("0 9 * * 2", tuesday)).toBe(true);

    // May 20, 2026 is Wednesday
    const wednesday = new Date(2026, 4, 20, 9, 0, 0);
    expect(matchesCron("0 9 * * 2", wednesday)).toBe(false);
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

  it("describes an onIssueStatus schedule with no project filter", () => {
    expect(describeSchedule({ type: "onIssueStatus", status: "Implementation Ready" })).toBe("On issue → Implementation Ready");
  });

  it("describes an onIssueStatus schedule with a project filter", () => {
    expect(describeSchedule({ type: "onIssueStatus", status: "Backlog", project: "proj-1" })).toBe("On issue → Backlog (project: proj-1)");
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
  it("returns the job's schedules array", () => {
    const s1: JobSchedule = { type: "simple", frequency: "daily", time: "09:00" };
    const s2: JobSchedule = { type: "cron", expression: "0 18 * * *" };
    const result = getJobSchedules({ schedules: [s1, s2] });
    expect(result).toEqual([s1, s2]);
  });

  it("returns an empty array for a job with no schedules", () => {
    expect(getJobSchedules({ schedules: [] })).toEqual([]);
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

  it("ignores onIssueStatus schedules and finds the next time-based one", () => {
    const after = new Date(2026, 4, 17, 10, 0, 0);
    const schedules: JobSchedule[] = [
      { type: "onIssueStatus", status: "Backlog" },
      { type: "simple", frequency: "daily", time: "15:00" },
    ];
    const next = getNextRunTimeAny(schedules, after);
    expect(next.getHours()).toBe(15);
  });

  it("falls back to the generic 'nothing matched' answer when every schedule is onIssueStatus (caller must check hasTimeBasedSchedule first)", () => {
    const after = new Date(2026, 4, 17, 10, 0, 0);
    const next = getNextRunTimeAny([{ type: "onIssueStatus", status: "Backlog" }], after);
    expect(next.getTime()).toBe(after.getTime() + 86400000);
  });
});

describe("hasTimeBasedSchedule", () => {
  it("is true for a plain simple/cron schedule list", () => {
    expect(hasTimeBasedSchedule([{ type: "simple", frequency: "daily", time: "09:00" }])).toBe(true);
    expect(hasTimeBasedSchedule([{ type: "cron", expression: "0 9 * * *" }])).toBe(true);
  });

  it("is true when a job mixes a time-based schedule with an onIssueStatus one", () => {
    const schedules: JobSchedule[] = [
      { type: "onIssueStatus", status: "Backlog" },
      { type: "cron", expression: "0 9 * * *" },
    ];
    expect(hasTimeBasedSchedule(schedules)).toBe(true);
  });

  it("is false when every schedule is onIssueStatus", () => {
    expect(hasTimeBasedSchedule([{ type: "onIssueStatus", status: "Backlog" }])).toBe(false);
  });

  it("is false for an empty schedule list", () => {
    expect(hasTimeBasedSchedule([])).toBe(false);
  });
});
