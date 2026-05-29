import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCockpitDir } from "@/server/paths";

function locksDir(): string {
  return join(getCockpitDir(), "job-locks");
}

interface LockData {
  pid: number;
  runId: string;
  acquiredAt: number;
}

function lockPath(jobId: string): string {
  return join(locksDir(), `${jobId}.lock`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(jobId: string): LockData | null {
  try {
    return JSON.parse(readFileSync(lockPath(jobId), "utf-8")) as LockData;
  } catch {
    return null;
  }
}

export function acquireJobLock(jobId: string, runId: string): boolean {
  mkdirSync(locksDir(), { recursive: true });
  const fp = lockPath(jobId);
  const data: LockData = { pid: process.pid, runId, acquiredAt: Date.now() };

  try {
    writeFileSync(fp, JSON.stringify(data) + "\n", { flag: "wx" });
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }

  const existing = readLock(jobId);
  if (!existing) {
    try {
      writeFileSync(fp, JSON.stringify(data) + "\n", { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }

  if (isPidAlive(existing.pid)) {
    return false;
  }

  console.log(`[scheduler] clearing stale lock for job ${jobId} (pid ${existing.pid} is dead)`);
  try {
    unlinkSync(fp);
  } catch {}
  try {
    writeFileSync(fp, JSON.stringify(data) + "\n", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export function releaseJobLock(jobId: string): void {
  try {
    const existing = readLock(jobId);
    if (existing && existing.pid === process.pid) {
      unlinkSync(lockPath(jobId));
    }
  } catch {}
}

export function forceReleaseJobLock(jobId: string): void {
  try {
    unlinkSync(lockPath(jobId));
  } catch {}
}

export function clearStaleLocks(): void {
  if (!existsSync(locksDir())) return;
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  for (const file of readdirSync(locksDir())) {
    if (!file.endsWith(".lock")) continue;
    const jobId = file.slice(0, -5);
    const lock = readLock(jobId);
    if (lock && !isPidAlive(lock.pid)) {
      console.log(`[scheduler] removing stale lock for job ${jobId} (pid ${lock.pid})`);
      try {
        unlinkSync(lockPath(jobId));
      } catch {}
    }
  }
}
