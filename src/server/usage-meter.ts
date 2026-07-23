// Local spend metering for proxied providers.
//
// OpenRouter exposes a spend API, but zen has none — its balance lives in the
// opencode.ai web console only. The format proxy sees every translated
// request's token usage, so cockpit meters spend itself: one JSONL row per
// request under ~/.cockpit, aggregated into windows at read time. Cost is
// derived from the provider's CURRENT model pricing when read (the W6 rule:
// prices are never persisted), so the numbers are estimates, clearly labeled
// as such in the UI.

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getCockpitDir } from "@/server/paths";

export interface ProviderUsageRecord {
  ts: number;
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderSpendWindow {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  /** Estimated from current per-model pricing; 0 for free models. */
  costUSD: number;
}

export interface ProviderUsageSummary {
  /** Since local midnight. */
  today: ProviderSpendWindow;
  /** Rolling 7 days. */
  week: ProviderSpendWindow;
  /** Rolling 30 days. */
  month: ProviderSpendWindow;
}

const RETAIN_MS = 45 * 24 * 60 * 60 * 1000;
const COMPACT_THRESHOLD_BYTES = 4 * 1024 * 1024;

function emptyWindow(): ProviderSpendWindow {
  return { inputTokens: 0, outputTokens: 0, requests: 0, costUSD: 0 };
}

export class UsageMeter {
  private file: string;
  private compactThresholdBytes: number;
  private retainMs: number;

  constructor(opts?: { file?: string; compactThresholdBytes?: number; retainMs?: number }) {
    this.file = opts?.file ?? join(getCockpitDir(), "provider-usage.jsonl");
    this.compactThresholdBytes = opts?.compactThresholdBytes ?? COMPACT_THRESHOLD_BYTES;
    this.retainMs = opts?.retainMs ?? RETAIN_MS;
  }

  /** Append one usage row. Metering must never break the request path, so
   *  every failure is swallowed. */
  record(r: ProviderUsageRecord): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(r) + "\n");
      this.maybeCompact();
    } catch {
      // best effort
    }
  }

  load(): ProviderUsageRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf-8");
    } catch {
      return [];
    }
    const out: ProviderUsageRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as ProviderUsageRecord;
        if (typeof r.ts === "number" && typeof r.providerId === "string") out.push(r);
      } catch {
        // skip torn/corrupt lines
      }
    }
    return out;
  }

  /** Drop rows older than the retention window once the file grows past the
   *  threshold. Amortized: runs on record(), rewrites in place. */
  private maybeCompact(): void {
    try {
      if (statSync(this.file).size < this.compactThresholdBytes) return;
    } catch {
      return;
    }
    const cutoff = Date.now() - this.retainMs;
    const keep = this.load().filter((r) => r.ts >= cutoff);
    writeFileSync(this.file, keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length > 0 ? "\n" : ""));
  }

  /** Aggregate a provider's rows into today/week/month windows, pricing each
   *  row from the given per-model pricing map (USD per 1M tokens). */
  summarize(
    providerId: string,
    pricing: Map<string, { inPerM: number; outPerM: number } | undefined>,
    now = Date.now(),
  ): ProviderUsageSummary {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const bounds: Array<[keyof ProviderUsageSummary, number]> = [
      ["today", midnight.getTime()],
      ["week", now - 7 * 24 * 60 * 60 * 1000],
      ["month", now - 30 * 24 * 60 * 60 * 1000],
    ];
    const summary: ProviderUsageSummary = { today: emptyWindow(), week: emptyWindow(), month: emptyWindow() };
    for (const r of this.load()) {
      if (r.providerId !== providerId || r.ts > now) continue;
      const p = pricing.get(r.modelId);
      const cost = p ? (r.inputTokens / 1e6) * p.inPerM + (r.outputTokens / 1e6) * p.outPerM : 0;
      for (const [key, since] of bounds) {
        if (r.ts < since) continue;
        const w = summary[key];
        w.inputTokens += r.inputTokens;
        w.outputTokens += r.outputTokens;
        w.requests += 1;
        w.costUSD += cost;
      }
    }
    return summary;
  }
}
