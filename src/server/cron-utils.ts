import type { JobSchedule, SimpleSchedule } from "@/types";

interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

function parseField(field: string, min: number, max: number): number[] {
  const values: number[] = [];
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    const range = stepMatch ? stepMatch[1] : part;

    if (range === "*") {
      for (let i = min; i <= max; i += step) values.push(i);
    } else if (range.includes("-")) {
      const [startStr, endStr] = range.split("-");
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      for (let i = start; i <= end; i += step) values.push(i);
    } else {
      values.push(parseInt(range, 10));
    }
  }
  return values;
}

function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
  }
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 6),
  };
}

export function matchesCron(expression: string, date: Date): boolean {
  const fields = parseCron(expression);
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();

  return (
    fields.minute.includes(minute) &&
    fields.hour.includes(hour) &&
    fields.dayOfMonth.includes(dom) &&
    fields.month.includes(month) &&
    fields.dayOfWeek.includes(dow)
  );
}

export function simpleScheduleToCron(schedule: SimpleSchedule): string {
  const time = schedule.time || "00:00";
  const [hour, minute] = time.split(":").map(Number);

  switch (schedule.frequency) {
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${schedule.dayOfWeek ?? 0}`;
    case "monthly":
      return `${minute} ${hour} ${schedule.dayOfMonth ?? 1} * *`;
  }
}

export function scheduleToCron(schedule: JobSchedule): string {
  if (schedule.type === "cron") return schedule.expression;
  return simpleScheduleToCron(schedule);
}

export function describeSchedule(schedule: JobSchedule): string {
  if (schedule.type === "cron") {
    return `cron: ${schedule.expression}`;
  }

  const time = schedule.time || "00:00";
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  switch (schedule.frequency) {
    case "hourly":
      return `Every hour at :${time.split(":")[1] || "00"}`;
    case "daily":
      return `Daily at ${time}`;
    case "weekly":
      return `Weekly on ${days[schedule.dayOfWeek ?? 0]} at ${time}`;
    case "monthly":
      return `Monthly on day ${schedule.dayOfMonth ?? 1} at ${time}`;
  }
}

export function getNextRunTime(schedule: JobSchedule, after: Date): Date {
  const cron = scheduleToCron(schedule);
  const fields = parseCron(cron);
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < 525960; i++) {
    if (
      fields.minute.includes(candidate.getMinutes()) &&
      fields.hour.includes(candidate.getHours()) &&
      fields.dayOfMonth.includes(candidate.getDate()) &&
      fields.month.includes(candidate.getMonth() + 1) &&
      fields.dayOfWeek.includes(candidate.getDay())
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return new Date(after.getTime() + 86400000);
}

export function findMissedRun(cronExpr: string, lastFiredAt: Date, now: Date): boolean {
  const maxLookbackMs = 24 * 60 * 60 * 1000;
  const earliest = new Date(Math.max(lastFiredAt.getTime() + 60000, now.getTime() - maxLookbackMs));
  const candidate = new Date(earliest);
  candidate.setSeconds(0, 0);

  while (candidate.getTime() < now.getTime()) {
    if (matchesCron(cronExpr, candidate)) {
      return true;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return false;
}
