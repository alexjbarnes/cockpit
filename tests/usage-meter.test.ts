import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageMeter } from "@/server/usage-meter";

const DAY = 24 * 60 * 60 * 1000;

describe("UsageMeter", () => {
  const dirs: string[] = [];

  function tempFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "usage-meter-"));
    dirs.push(dir);
    return join(dir, "provider-usage.jsonl");
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("records rows and loads them back", () => {
    const meter = new UsageMeter({ file: tempFile() });
    meter.record({ ts: 1000, providerId: "zen", modelId: "m1", inputTokens: 10, outputTokens: 20 });
    meter.record({ ts: 2000, providerId: "zen", modelId: "m2", inputTokens: 1, outputTokens: 2 });
    expect(meter.load()).toEqual([
      { ts: 1000, providerId: "zen", modelId: "m1", inputTokens: 10, outputTokens: 20 },
      { ts: 2000, providerId: "zen", modelId: "m2", inputTokens: 1, outputTokens: 2 },
    ]);
  });

  it("returns empty for a missing file and skips corrupt lines", () => {
    const file = tempFile();
    const meter = new UsageMeter({ file });
    expect(meter.load()).toEqual([]);
    writeFileSync(file, '{"ts":1,"providerId":"zen","modelId":"m","inputTokens":1,"outputTokens":1}\n{torn\n{"nots":true}\n');
    expect(meter.load()).toEqual([{ ts: 1, providerId: "zen", modelId: "m", inputTokens: 1, outputTokens: 1 }]);
  });

  it("swallows write failures", () => {
    // The file path is a directory: appendFileSync throws EISDIR, record must not.
    const dir = mkdtempSync(join(tmpdir(), "usage-meter-"));
    dirs.push(dir);
    const meter = new UsageMeter({ file: dir });
    expect(() => meter.record({ ts: 1, providerId: "zen", modelId: "m", inputTokens: 1, outputTokens: 1 })).not.toThrow();
  });

  it("summarizes into today/week/month windows with derived cost", () => {
    const meter = new UsageMeter({ file: tempFile() });
    const now = new Date(2026, 6, 23, 12, 0, 0).getTime();
    const midnight = new Date(2026, 6, 23, 0, 0, 0).getTime();
    meter.record({ ts: midnight + 1000, providerId: "zen", modelId: "paid", inputTokens: 1_000_000, outputTokens: 500_000 });
    meter.record({ ts: now - 3 * DAY, providerId: "zen", modelId: "paid", inputTokens: 2_000_000, outputTokens: 0 });
    meter.record({ ts: now - 20 * DAY, providerId: "zen", modelId: "free", inputTokens: 999, outputTokens: 999 });
    meter.record({ ts: now - 40 * DAY, providerId: "zen", modelId: "paid", inputTokens: 1, outputTokens: 1 });
    meter.record({ ts: now - 1000, providerId: "deepseek", modelId: "paid", inputTokens: 5, outputTokens: 5 });
    meter.record({ ts: now + 1000, providerId: "zen", modelId: "paid", inputTokens: 5, outputTokens: 5 });

    const pricing = new Map<string, { inPerM: number; outPerM: number } | undefined>([
      ["paid", { inPerM: 2, outPerM: 10 }],
      ["free", { inPerM: 0, outPerM: 0 }],
    ]);
    const s = meter.summarize("zen", pricing, now);

    // today: 1M in @ $2 + 0.5M out @ $10 = $7
    expect(s.today).toEqual({ inputTokens: 1_000_000, outputTokens: 500_000, requests: 1, costUSD: 7 });
    // week adds the 3-day-old row (+$4); other providers and future rows excluded
    expect(s.week).toEqual({ inputTokens: 3_000_000, outputTokens: 500_000, requests: 2, costUSD: 11 });
    // month adds the free row at zero cost; the 40-day row stays out
    expect(s.month.requests).toBe(3);
    expect(s.month.costUSD).toBe(11);
  });

  it("prices unknown models at zero", () => {
    const meter = new UsageMeter({ file: tempFile() });
    const now = Date.now();
    meter.record({ ts: now - 1000, providerId: "zen", modelId: "gone", inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const s = meter.summarize("zen", new Map(), now);
    expect(s.month).toEqual({ inputTokens: 1_000_000, outputTokens: 1_000_000, requests: 1, costUSD: 0 });
  });

  it("compacts rows past retention once the file crosses the threshold", () => {
    const file = tempFile();
    const meter = new UsageMeter({ file, compactThresholdBytes: 1, retainMs: 10 * DAY });
    const now = Date.now();
    meter.record({ ts: now - 20 * DAY, providerId: "zen", modelId: "old", inputTokens: 1, outputTokens: 1 });
    // The second record triggers compaction (file already over threshold),
    // dropping the 20-day-old row.
    meter.record({ ts: now, providerId: "zen", modelId: "new", inputTokens: 1, outputTokens: 1 });
    const kept = meter.load().map((r) => r.modelId);
    expect(kept).toEqual(["new"]);
    expect(readFileSync(file, "utf-8").endsWith("\n")).toBe(true);
  });
});
