import { describe, expect, it } from "vitest";
import { createStaleGuard } from "@/lib/stale-guard";

describe("createStaleGuard", () => {
  it("reports the only run in flight as current", () => {
    const isStale = createStaleGuard().begin();
    expect(isStale()).toBe(false);
  });

  it("marks an earlier run stale as soon as a later one begins, and keeps it stale", () => {
    const guard = createStaleGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(first()).toBe(true);
    expect(second()).toBe(false);
    // The late-landing run must not un-stale itself by being asked twice.
    expect(first()).toBe(true);
  });

  it("keeps only the newest of several overlapping runs", () => {
    const guard = createStaleGuard();
    const runs = [guard.begin(), guard.begin(), guard.begin()];
    expect(runs.map((isStale) => isStale())).toEqual([true, true, false]);
  });

  it("tracks each guard independently", () => {
    const a = createStaleGuard();
    const b = createStaleGuard();
    const aRun = a.begin();
    b.begin();
    expect(aRun()).toBe(false);
  });

  // The ordering that produced the bug: run A starts, run B starts and finishes
  // with the new session, then A's slow response comes back. A must drop it.
  it("survives the out-of-order completion it exists for", async () => {
    const guard = createStaleGuard();
    let rendered: string[] = [];

    const run = async (result: string[], delayMs: number) => {
      const isStale = guard.begin();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (isStale()) return;
      rendered = result;
    };

    const slowFirst = run(["old"], 20);
    const fastSecond = run(["old", "new"], 1);
    await Promise.all([slowFirst, fastSecond]);

    expect(rendered).toEqual(["old", "new"]);
  });
});
