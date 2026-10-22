/**
 * What a model's tokens cost, by the provider that served them.
 *
 * Claude Code prices every request at Anthropic's rates, which is right for
 * Anthropic's models and wrong for any other provider's. So its figure is
 * kept only for Anthropic's models, and the rest are priced from the
 * provider's catalogue at read time, the way cockpit's usage meter does. A
 * model with no price is counted as unpriced, never as free.
 */

import type { InsightsMoney, InsightsTokens } from "@/types";

/** USD per million tokens, as provider catalogues carry it. */
export interface PriceSpec {
  inPerM: number;
  outPerM: number;
  cacheReadPerM?: number;
}

export type PriceSource = { kind: "cli" } | { kind: "catalogue"; pricing: PriceSpec } | { kind: "free" } | { kind: "none" };

export function emptyMoney(): InsightsMoney {
  return { usd: 0, apiEquivalentUsd: 0, unpricedRequests: 0 };
}

export function addMoney(into: InsightsMoney, more: InsightsMoney): InsightsMoney {
  into.usd += more.usd;
  into.apiEquivalentUsd += more.apiEquivalentUsd;
  into.unpricedRequests += more.unpricedRequests;
  return into;
}

/**
 * The cost of some requests' tokens. Telemetry's input excludes cache reads
 * and cache writes, so each is priced on its own: reads at the cache rate
 * when the catalogue has one, writes at the input rate (catalogues carry no
 * write rate, and the providers that charge one charge about that).
 */
export function priceUsage(tokens: InsightsTokens, cliCostUsd: number, requests: number, source: PriceSource): InsightsMoney {
  switch (source.kind) {
    case "cli":
      return { usd: cliCostUsd, apiEquivalentUsd: cliCostUsd, unpricedRequests: 0 };
    case "free":
      return emptyMoney();
    case "none":
      return { usd: 0, apiEquivalentUsd: 0, unpricedRequests: requests };
    case "catalogue": {
      const p = source.pricing;
      const usd =
        (tokens.input * p.inPerM +
          tokens.cacheRead * (p.cacheReadPerM ?? p.inPerM) +
          tokens.cacheWrite * p.inPerM +
          tokens.output * p.outPerM) /
        1e6;
      return { usd, apiEquivalentUsd: 0, unpricedRequests: 0 };
    }
  }
}

export function totalTokens(t: InsightsTokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

/** Cache reads over everything sent to the model, or null when nothing was. */
export function cacheHitRate(t: InsightsTokens): number | null {
  const sent = t.input + t.cacheRead + t.cacheWrite;
  return sent > 0 ? t.cacheRead / sent : null;
}
