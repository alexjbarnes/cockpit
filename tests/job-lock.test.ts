import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DIR = vi.hoisted(() => {
  const p = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");
  return p.join(os.tmpdir(), `cockpit-lock-test-${process.pid}`);
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => TEST_DIR };
});

const LOCKS_DIR = join(TEST_DIR, ".cockpit", "job-locks");

import { acquireJobLock, clearStaleLocks, forceReleaseJobLock, releaseJobLock } from "@/server/job-lock";

function readLockFile(jobId: string): { pid: number; runId: string; acquiredAt: number } | null {
  try {
    return JSON.parse(readFileSync(join(LOCKS_DIR, `${jobId}.lock`), "utf-8"));
  } catch {
    return null;
  }
}

function writeFakeLock(jobId: string, pid: number, runId: string): void {
  mkdirSync(LOCKS_DIR, { recursive: true });
  writeFileSync(join(LOCKS_DIR, `${jobId}.lock`), JSON.stringify({ pid, runId, acquiredAt: Date.now() }) + "\n");
}

beforeEach(() => {
  mkdirSync(LOCKS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("acquireJobLock", () => {
  it("creates lock file on first acquire", () => {
    expect(acquireJobLock("job-1", "run-1")).toBe(true);
    const data = readLockFile("job-1");
    expect(data).not.toBeNull();
    expect(data!.pid).toBe(process.pid);
    expect(data!.runId).toBe("run-1");
  });

  it("fails when lock already held by current process", () => {
    expect(acquireJobLock("job-2", "run-1")).toBe(true);
    expect(acquireJobLock("job-2", "run-2")).toBe(false);
  });

  it("takes over lock from dead process", () => {
    writeFakeLock("job-3", 999999, "old-run");
    expect(acquireJobLock("job-3", "new-run")).toBe(true);
    const data = readLockFile("job-3");
    expect(data!.pid).toBe(process.pid);
    expect(data!.runId).toBe("new-run");
  });

  it("returns false for non-EEXIST write errors", () => {
    mkdirSync(join(LOCKS_DIR, "job-4.lock"), { recursive: true });
    expect(acquireJobLock("job-4", "run-1")).toBe(false);
  });
});

describe("releaseJobLock", () => {
  it("removes lock owned by current process", () => {
    acquireJobLock("job-5", "run-1");
    expect(readLockFile("job-5")).not.toBeNull();
    releaseJobLock("job-5");
    expect(readLockFile("job-5")).toBeNull();
  });

  it("does not remove lock owned by another process", () => {
    writeFakeLock("job-6", 999999, "foreign-run");
    releaseJobLock("job-6");
    expect(readLockFile("job-6")).not.toBeNull();
  });

  it("does nothing when no lock exists", () => {
    expect(() => releaseJobLock("nonexistent")).not.toThrow();
  });
});

describe("forceReleaseJobLock", () => {
  it("removes lock regardless of owner", () => {
    writeFakeLock("job-7", 999999, "foreign-run");
    forceReleaseJobLock("job-7");
    expect(readLockFile("job-7")).toBeNull();
  });

  it("does nothing when no lock exists", () => {
    expect(() => forceReleaseJobLock("nonexistent")).not.toThrow();
  });
});

describe("clearStaleLocks", () => {
  it("removes locks from dead processes", () => {
    writeFakeLock("job-8", 999999, "dead-run");
    clearStaleLocks();
    expect(readLockFile("job-8")).toBeNull();
  });

  it("preserves locks from live processes", () => {
    writeFakeLock("job-9", process.pid, "live-run");
    clearStaleLocks();
    expect(readLockFile("job-9")).not.toBeNull();
  });

  it("handles missing locks directory", () => {
    rmSync(LOCKS_DIR, { recursive: true, force: true });
    expect(() => clearStaleLocks()).not.toThrow();
  });

  it("skips non-lock files", () => {
    writeFileSync(join(LOCKS_DIR, "readme.txt"), "not a lock");
    expect(() => clearStaleLocks()).not.toThrow();
    expect(existsSync(join(LOCKS_DIR, "readme.txt"))).toBe(true);
  });
});
