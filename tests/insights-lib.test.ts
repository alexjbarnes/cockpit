// The arithmetic and parsing behind Insights: ranges on the viewer's clock,
// percentiles and where a turn's time went, pricing by provider, the names
// telemetry identifiers are shown under, axis maths and number formats.
import { describe, expect, it } from "vitest";
import { countOf, formatCount, formatMs, formatPercent, formatTokens, formatUSD } from "@/lib/format-number";
import { nearestIndex, niceMax, slotAt, tickIndexes } from "@/lib/insights/chart";
import { effortLabel, mcpTool, projectForSession, purposeKey, purposeLabel } from "@/lib/insights/labels";
import { addMoney, cacheHitRate, emptyMoney, priceUsage, totalTokens } from "@/lib/insights/pricing";
import { bucketStart, parseInsightsQuery, rangeBounds } from "@/lib/insights/query";
import {
  bucketIndex,
  bucketStarts,
  durations,
  histogram,
  mergeIntervals,
  percentile,
  turnBreakdown,
  unionLength,
} from "@/lib/insights/stats";
import type { Project } from "@/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 2026-10-21 13:30 UTC
const NOW = Date.UTC(2026, 9, 21, 13, 30);

describe("insights query", () => {
  it("lines buckets up with the viewer's clock", () => {
    expect(bucketStart(NOW, HOUR, 0)).toBe(Date.UTC(2026, 9, 21, 13));
    // An hour ahead of UTC: local midnight is 23:00 UTC the day before.
    expect(bucketStart(NOW, DAY, 60)).toBe(Date.UTC(2026, 9, 20, 23));
    // Half an hour ahead: local hours start at :30 UTC.
    expect(bucketStart(NOW, HOUR, 330)).toBe(Date.UTC(2026, 9, 21, 13, 30));
  });

  it("ends a range with the bucket holding now and starts it whole buckets before", () => {
    expect(rangeBounds("24h", NOW, 0)).toEqual({ since: Date.UTC(2026, 9, 20, 14), until: Date.UTC(2026, 9, 21, 14), bucketMs: HOUR });
    expect(rangeBounds("7d", NOW, 0)).toEqual({ since: Date.UTC(2026, 9, 15), until: Date.UTC(2026, 9, 22), bucketMs: DAY });
    const month = rangeBounds("30d", NOW, -300);
    expect((month.until - month.since) / DAY).toBe(30);
  });

  it("parses a view with its defaults", () => {
    const parsed = parseInsightsQuery(new URLSearchParams("view=spend"), NOW);
    expect(parsed).toEqual({ query: { view: "spend", range: "7d", tzOffsetMin: 0, ...rangeBounds("7d", NOW, 0) } });
    const full = parseInsightsQuery(
      new URLSearchParams("view=turn&range=24h&tz=-480&session=abc-1&turn=0123456789abcdef0123456789abcdef"),
      NOW,
    );
    expect(full).toMatchObject({
      query: { view: "turn", range: "24h", tzOffsetMin: -480, session: "abc-1", turn: "0123456789abcdef0123456789abcdef" },
    });
  });

  it("refuses anything present but wrong", () => {
    const error = (qs: string) => {
      const parsed = parseInsightsQuery(new URLSearchParams(qs), NOW);
      return "error" in parsed ? parsed.error : null;
    };
    expect(error("")).toMatch(/view must be/);
    expect(error("view=nope")).toMatch(/view must be/);
    expect(error("view=spend&range=1y")).toMatch(/range must be/);
    expect(error("view=spend&tz=abc")).toMatch(/tz must be/);
    expect(error("view=spend&tz=900")).toMatch(/tz must be/);
    expect(error("view=spend&session=a/b")).toMatch(/session must be/);
    expect(error("view=turns")).toMatch(/needs a session/);
    expect(error("view=context")).toMatch(/needs a session/);
    expect(error("view=turn&session=s")).toMatch(/needs a turn/);
    expect(error("view=spend&turn=xyz")).toMatch(/turn must be/);
  });
});

describe("insights stats", () => {
  it("interpolates percentiles and has none for no values", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1);
    expect(percentile([1, 2], 2)).toBe(2);
    expect(durations([10, 20, 30])).toEqual({ count: 3, p50: 20, p90: 28 });
  });

  it("bins values with an open last bin", () => {
    expect(histogram([5, 10, 25, 999], [10, 30])).toEqual([
      { fromMs: 0, toMs: 10, count: 1 },
      { fromMs: 10, toMs: 30, count: 2 },
      { fromMs: 30, toMs: null, count: 1 },
    ]);
    expect(histogram([1], [])).toEqual([{ fromMs: 0, toMs: null, count: 1 }]);
  });

  it("lists bucket starts and finds a time's bucket", () => {
    expect(bucketStarts(0, 3 * HOUR, HOUR)).toEqual([0, HOUR, 2 * HOUR]);
    expect(bucketIndex(HOUR + 1, 0, 3 * HOUR, HOUR)).toBe(1);
    expect(bucketIndex(-1, 0, 3 * HOUR, HOUR)).toBe(-1);
    expect(bucketIndex(3 * HOUR, 0, 3 * HOUR, HOUR)).toBe(-1);
  });

  it("merges overlapping intervals and drops empty ones", () => {
    expect(
      mergeIntervals([
        [5, 8],
        [1, 3],
        [2, 4],
        [9, 9],
      ]),
    ).toEqual([
      [1, 4],
      [5, 8],
    ]);
    expect(
      unionLength([
        [0, 10],
        [5, 15],
        [20, 25],
      ]),
    ).toBe(20);
  });

  it("splits a turn so a wait counts once, parallel tools once, and the gaps as other", () => {
    const split = turnBreakdown(0, 100, {
      waiting: [[10, 20]],
      // Two tools at once, one of them inside the wait it belongs to.
      tools: [
        [15, 40],
        [30, 50],
      ],
      model: [
        [0, 12],
        [45, 70],
        [95, 120],
      ],
    });
    // Model covers [0,12], [45,70] and [95,100] after clipping; 35 of that is not already waiting or tools.
    expect(split).toEqual({ waitingMs: 10, toolsMs: 30, modelMs: 35, otherMs: 25 });
  });
});

describe("insights pricing", () => {
  const tokens = { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 100_000 };

  it("keeps Claude Code's figure for Anthropic's models, as an API-price one", () => {
    expect(priceUsage(tokens, 4.2, 3, { kind: "cli" })).toEqual({ usd: 4.2, apiEquivalentUsd: 4.2, unpricedRequests: 0 });
  });

  it("prices other models from the catalogue: cache reads at their rate, writes at the input rate", () => {
    const money = priceUsage(tokens, 99, 3, { kind: "catalogue", pricing: { inPerM: 0.3, outPerM: 1.2, cacheReadPerM: 0.03 } });
    expect(money.usd).toBeCloseTo(0.3 + 0.6 + 0.06 + 0.03);
    expect(money.apiEquivalentUsd).toBe(0);
    const noCacheRate = priceUsage(tokens, 0, 1, { kind: "catalogue", pricing: { inPerM: 1, outPerM: 2 } });
    expect(noCacheRate.usd).toBeCloseTo(1 + 1 + 2 + 0.1);
  });

  it("counts a free model as nothing and an unpriced one as unpriced, never as free", () => {
    expect(priceUsage(tokens, 5, 2, { kind: "free" })).toEqual(emptyMoney());
    expect(priceUsage(tokens, 5, 2, { kind: "none" })).toEqual({ usd: 0, apiEquivalentUsd: 0, unpricedRequests: 2 });
  });

  it("adds money and tokens, and rates the cache over everything sent", () => {
    expect(addMoney({ usd: 1, apiEquivalentUsd: 1, unpricedRequests: 0 }, { usd: 2, apiEquivalentUsd: 0, unpricedRequests: 3 })).toEqual({
      usd: 3,
      apiEquivalentUsd: 1,
      unpricedRequests: 3,
    });
    expect(totalTokens(tokens)).toBe(3_600_000);
    expect(cacheHitRate(tokens)).toBeCloseTo(2 / 3.1);
    expect(cacheHitRate({ input: 0, output: 10, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });
});

describe("insights labels", () => {
  const project = (id: string, prefix: string, repoPath?: string, archived = false): Project => ({
    id,
    name: `Project ${prefix}`,
    prefix,
    repoPath,
    archived,
    createdAt: 0,
    updatedAt: 0,
    nextNumber: 1,
  });

  it("names what each request was for, grouping every subagent together", () => {
    expect(purposeLabel("repl_main_thread")).toBe("Conversation");
    expect(purposeLabel("generate_session_title")).toBe("Session titles");
    expect(purposeLabel("agent:custom")).toBe("Subagents");
    expect(purposeLabel("some_new_source")).toBe("Some new source");
    expect(purposeLabel(null)).toBe("Other");
    expect(purposeLabel("__")).toBe("Other");
    expect(purposeKey("agent:explore")).toBe("subagents");
    expect(purposeKey("repl_main_thread")).toBe("repl_main_thread");
    expect(purposeKey(undefined)).toBe("other");
    expect(purposeLabel(purposeKey("agent:explore"))).toBe("Subagents");
  });

  it("names effort levels", () => {
    expect(effortLabel("max")).toBe("Max");
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel(null)).toBe("Default");
  });

  it("finds a session's project by repo, by an issue worktree, then by folder", () => {
    const projects = [
      project("p1", "CK", "/home/dev/repos/cockpit"),
      project("p2", "RO", undefined),
      project("p3", "OLD", undefined, true),
    ];
    expect(projectForSession(projects, "/home/dev/repos/cockpit/src")).toEqual({ key: "p1", label: "Project CK" });
    expect(projectForSession(projects, "/home/dev/repos/roasta-RO-12")).toEqual({ key: "p2", label: "Project RO" });
    expect(projectForSession(projects, "/home/dev/repos/thing-OLD-3")).toEqual({ key: "dir:thing", label: "thing" });
    expect(projectForSession(projects, "/home/dev/repos/homelab/")).toEqual({ key: "dir:homelab", label: "homelab" });
    expect(projectForSession(projects, "/home/dev/.cockpit/jobs/c02ccdfa-8eae-438e-abc6-064a8a28a423")).toBeUndefined();
    expect(projectForSession(projects, undefined)).toBeUndefined();
    expect(projectForSession(projects, "/")).toBeUndefined();
  });

  it("splits an MCP tool's name into its server and tool", () => {
    expect(mcpTool("mcp__gmail__read_email")).toEqual({ server: "gmail", tool: "read_email" });
    expect(mcpTool("mcp__plugin_graphene_graphene__learn")).toEqual({ server: "plugin_graphene_graphene", tool: "learn" });
    expect(mcpTool("Bash")).toBeNull();
  });
});

describe("insights chart maths", () => {
  it("spaces tick labels by the room there is", () => {
    expect(tickIndexes(30, 330)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(tickIndexes(7, 900)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(tickIndexes(0, 300)).toEqual([]);
    expect(tickIndexes(5, 0)).toEqual([]);
    expect(tickIndexes(3, 20)).toEqual([0]);
  });

  it("rounds an axis top up to a readable number", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
    expect(niceMax(0.43)).toBe(0.5);
    expect(niceMax(1.7)).toBe(2);
    expect(niceMax(2.2)).toBe(2.5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(4_600_000)).toBe(5_000_000);
  });

  it("finds the slot under a pointer and the nearest point", () => {
    expect(slotAt(0, 300, 30)).toBe(0);
    expect(slotAt(299, 300, 30)).toBe(29);
    expect(slotAt(400, 300, 30)).toBe(29);
    expect(slotAt(-5, 300, 30)).toBe(0);
    expect(slotAt(10, 0, 30)).toBe(-1);
    expect(nearestIndex([], 5)).toBe(-1);
    expect(nearestIndex([0, 10, 20], 4)).toBe(0);
    expect(nearestIndex([0, 10, 20], 6)).toBe(1);
    expect(nearestIndex([0, 10, 20], 99)).toBe(2);
    expect(nearestIndex([0, 10, 20], 15)).toBe(1);
  });
});

describe("number formats", () => {
  it("formats tokens compactly", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_600)).toBe("13k");
    expect(formatTokens(4_600)).toBe("4.6k");
    expect(formatTokens(4_000)).toBe("4k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(45_000_000)).toBe("45M");
    expect(formatTokens(3_400_000_000)).toBe("3.4B");
  });

  it("formats dollars by size", () => {
    expect(formatUSD(0)).toBe("$0");
    expect(formatUSD(0.004)).toBe("<$0.01");
    expect(formatUSD(4.284)).toBe("$4.28");
    expect(formatUSD(123.4)).toBe("$123");
    expect(formatUSD(12_345)).toBe("$12k");
    expect(formatUSD(-2.5)).toBe("-$2.50");
  });

  it("formats shares, counts and durations", () => {
    expect(formatPercent(0.684)).toBe("68%");
    expect(formatPercent(0.001)).toBe("<1%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(12_345)).toBe("12k");
    expect(formatMs(850)).toBe("850 ms");
    expect(formatMs(1500)).toBe("1.5 s");
    expect(formatMs(12_000)).toBe("12 s");
    expect(formatMs(125_000)).toBe("2m 5s");
    expect(countOf(1, "turn")).toBe("1 turn");
    expect(countOf(3, "turn")).toBe("3 turns");
    expect(countOf(2, "box", "boxes")).toBe("2 boxes");
  });
});
