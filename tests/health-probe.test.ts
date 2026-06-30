import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyStall, startHealthProbe } from "@/server/health-probe";

describe("classifyStall", () => {
  it("returns null when neither metric exceeds its threshold", () => {
    expect(classifyStall(0, 0)).toBeNull();
    expect(classifyStall(199, 99)).toBeNull();
  });

  it("blames the event loop when loop lag dominates", () => {
    const line = classifyStall(1800, 5);
    expect(line).toContain("EVENT LOOP blocked");
    expect(line).toContain("loopLag=1800ms");
    expect(line).toContain("fsRead=5ms");
  });

  it("blames fs/thread-pool when the read lag dominates (loop free)", () => {
    const line = classifyStall(3, 1800);
    expect(line).toContain("fs thread-pool / disk contention");
    expect(line).toContain("fsRead=1800ms");
  });

  it("fires when only the fs read crosses its (lower) threshold", () => {
    expect(classifyStall(0, 150)).toContain("fs thread-pool");
  });
});

describe("startHealthProbe", () => {
  it("runs the probe loop with no spikes and stops cleanly", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hp-"));
    const logs: string[] = [];
    const stop = startHealthProbe(dir, (m) => logs.push(m), 30);
    // A few fast ticks: the probe file read is instant, so nothing is logged.
    await new Promise((r) => setTimeout(r, 130));
    stop();
    const afterStop = logs.length;
    await new Promise((r) => setTimeout(r, 70));
    expect(logs).toHaveLength(0); // healthy run -> no stall lines
    expect(logs.length).toBe(afterStop); // stop() halts further ticks
  });
});
