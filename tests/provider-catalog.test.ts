// Exercises the OpenRouter catalog module against a real tmpdir via
// COCKPIT_CONFIG_DIR (the same isolation pattern as job-storage.test.ts), a
// stubbed global fetch, and a mocked inbox. The fixture is a trimmed capture
// of the real GET /api/v1/models response (docs/internal spike, 2026-07-22).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/inbox", () => ({
  addInboxMessage: vi.fn(),
}));

import { addInboxMessage } from "@/server/inbox";

const FIXTURE = JSON.parse(readFileSync(join(__dirname, "fixtures", "openrouter-models.json"), "utf-8"));

let dir: string;

function fetchOk(body: unknown): typeof fetch {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}

function fetchFail(): typeof fetch {
  return vi.fn(async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
}

async function loadModule() {
  return await import("@/server/provider-catalog");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
  process.env.COCKPIT_CONFIG_DIR = dir;
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.COCKPIT_CONFIG_DIR;
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("catalog mapping", () => {
  it("maps the real fixture: free flags, pricing per M, context, capabilities", async () => {
    vi.stubGlobal("fetch", fetchOk(FIXTURE));
    const cat = await loadModule();
    const result = await cat.syncOpenRouterCatalog();
    expect(result.ok).toBe(true);

    const models = cat.catalogModels();
    const byId = new Map(models.map((m) => [m.modelId, m]));

    const nemotron = byId.get("nvidia/nemotron-3-super-120b-a12b:free");
    expect(nemotron?.free).toBe(true);
    expect(nemotron?.supportsTools).toBe(true);
    expect(nemotron?.contextLength).toBe(262144);
    expect(nemotron?.pricing).toEqual({ inPerM: 0, outPerM: 0 });

    const sonnet = byId.get("anthropic/claude-sonnet-5");
    expect(sonnet?.free).toBe(false);
    expect(sonnet?.pricing?.inPerM).toBeCloseTo(2);
    expect(sonnet?.pricing?.outPerM).toBeCloseTo(10);

    // meta-router: zero-priced but never badged free
    expect(byId.get("openrouter/free")?.free).toBe(false);
    // media model: zero prompt/completion but bills on audio pricing
    expect(byId.get("google/lyria-3-pro-preview")?.free).toBe(false);

    expect(byId.get("poolside/laguna-m.1:free")?.expirationDate).toBe("2026-07-28");
    expect(byId.get("nvidia/nemotron-nano-12b-v2-vl:free")?.supportsImageInput).toBe(true);
    // catalog models carry no Anthropic-style enums
    expect(nemotron?.effortLevels).toEqual([]);
    expect(nemotron?.contextSizes).toEqual([]);
  });

  it("badges a zero-priced text model without the :free suffix as free", async () => {
    const cat = await loadModule();
    const mapped = cat.mapOpenRouterModel({
      id: "vendor/promo-model",
      name: "Promo",
      context_length: 32768,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["tools"],
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    });
    expect(mapped?.free).toBe(true);
  });

  it("drops models with no text output", async () => {
    const cat = await loadModule();
    const mapped = cat.mapOpenRouterModel({
      id: "vendor/tts",
      pricing: { prompt: "0", completion: "0" },
      architecture: { output_modalities: ["audio"] },
    });
    expect(mapped).toBeNull();
  });
});

describe("computeCatalogDiff", () => {
  it("reports delisted, free-to-paid, and price changes", async () => {
    const cat = await loadModule();
    const model = (id: string, inPerM: number, outPerM: number, free = false) => ({
      modelId: id,
      displayName: id,
      effortLevels: [],
      contextSizes: [],
      pricing: { inPerM, outPerM },
      free,
    });
    const prev = [model("a", 0, 0, true), model("b", 1, 2), model("c", 5, 10)];
    const next = [model("a", 0.3, 1.1), model("b", 1, 3)];
    const changes = cat.computeCatalogDiff(prev, next);
    expect(changes).toEqual([
      { kind: "free-to-paid", modelId: "a", detail: "free → $0.3/$1.1 per M" },
      { kind: "price-changed", modelId: "b", detail: "$1/$2 → $1/$3 per M" },
      { kind: "delisted", modelId: "c", detail: "no longer offered" },
    ]);
  });
});

describe("D8 sync-failure alerting", () => {
  it("alerts once after 3 consecutive failures, resets on success, alerts again next episode", async () => {
    vi.stubGlobal("fetch", fetchFail());
    const cat = await loadModule();
    await cat.syncOpenRouterCatalog();
    await cat.syncOpenRouterCatalog();
    expect(vi.mocked(addInboxMessage)).not.toHaveBeenCalled();
    await cat.syncOpenRouterCatalog();
    expect(vi.mocked(addInboxMessage)).toHaveBeenCalledTimes(1);
    // further failures stay silent within the episode
    await cat.syncOpenRouterCatalog();
    expect(vi.mocked(addInboxMessage)).toHaveBeenCalledTimes(1);

    vi.stubGlobal("fetch", fetchOk(FIXTURE));
    await cat.syncOpenRouterCatalog();

    vi.stubGlobal("fetch", fetchFail());
    await cat.syncOpenRouterCatalog();
    await cat.syncOpenRouterCatalog();
    await cat.syncOpenRouterCatalog();
    expect(vi.mocked(addInboxMessage)).toHaveBeenCalledTimes(2);
  });

  it("alerts on the first failure once the cache is older than 48h", async () => {
    const cat = await loadModule();
    writeFileSync(
      join(dir, "provider-catalog.json"),
      JSON.stringify({ syncedAt: Date.now() - 49 * 60 * 60 * 1000, consecutiveFailures: 0, models: [], delisted: [] }),
    );
    vi.stubGlobal("fetch", fetchFail());
    await cat.syncOpenRouterCatalog();
    expect(vi.mocked(addInboxMessage)).toHaveBeenCalledTimes(1);
    const body = vi.mocked(addInboxMessage).mock.calls[0][0];
    expect(body.title).toContain("refresh is failing");
  });

  it("does not alert on healthy syncs", async () => {
    vi.stubGlobal("fetch", fetchOk(FIXTURE));
    const cat = await loadModule();
    await cat.syncOpenRouterCatalog();
    await cat.syncOpenRouterCatalog();
    expect(vi.mocked(addInboxMessage)).not.toHaveBeenCalled();
  });
});

describe("D9 relevant-change notifications", () => {
  it("notifies only for changes touching enabled, slotted, or job models", async () => {
    vi.stubGlobal("fetch", fetchOk(FIXTURE));
    const cat = await loadModule();
    await cat.syncOpenRouterCatalog();

    // enable one model; the other change (delisting laguna-s-2.1) is not in use
    writeFileSync(
      join(dir, "providers.json"),
      JSON.stringify([
        {
          id: "openrouter",
          name: "OpenRouter",
          isBuiltin: true,
          models: [],
          envVars: {},
          enabledModels: ["nvidia/nemotron-3-super-120b-a12b:free"],
        },
      ]),
    );

    const modified = {
      data: FIXTURE.data
        .filter((m: { id: string }) => m.id !== "poolside/laguna-s-2.1")
        .map((m: { id: string; pricing: Record<string, string> }) =>
          m.id === "nvidia/nemotron-3-super-120b-a12b:free"
            ? { ...m, id: m.id, pricing: { prompt: "0.0000003", completion: "0.0000011" } }
            : m,
        ),
    };
    vi.stubGlobal("fetch", fetchOk(modified));
    await cat.syncOpenRouterCatalog();

    expect(vi.mocked(addInboxMessage)).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(addInboxMessage).mock.calls[0][0];
    expect(msg.body).toContain("nvidia/nemotron-3-super-120b-a12b:free");
    expect(msg.body).not.toContain("poolside/laguna-s-2.1");
  });

  it("stays silent when changes touch nothing in use", async () => {
    vi.stubGlobal("fetch", fetchOk(FIXTURE));
    const cat = await loadModule();
    await cat.syncOpenRouterCatalog();

    const modified = { data: FIXTURE.data.filter((m: { id: string }) => m.id !== "poolside/laguna-s-2.1") };
    vi.stubGlobal("fetch", fetchOk(modified));
    await cat.syncOpenRouterCatalog();
    expect(vi.mocked(addInboxMessage)).not.toHaveBeenCalled();
  });
});

describe("checkJobModel", () => {
  it("passes non-openrouter models and passes everything before a first sync", async () => {
    const cat = await loadModule();
    expect(cat.checkJobModel("sonnet").ok).toBe(true);
    expect(cat.checkJobModel(undefined).ok).toBe(true);
    expect(cat.checkJobModel("openrouter:whatever/model").ok).toBe(true);
  });

  it("fails a job model missing from the synced catalog, naming it", async () => {
    vi.stubGlobal("fetch", fetchOk(FIXTURE));
    const cat = await loadModule();
    await cat.syncOpenRouterCatalog();

    expect(cat.checkJobModel("openrouter:nvidia/nemotron-3-super-120b-a12b:free").ok).toBe(true);
    const missing = cat.checkJobModel("openrouter:vendor/never-existed");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("openrouter:vendor/never-existed");
  });

  it("reports a delisted model as no longer offered", async () => {
    vi.stubGlobal("fetch", fetchOk(FIXTURE));
    const cat = await loadModule();
    await cat.syncOpenRouterCatalog();
    const modified = { data: FIXTURE.data.filter((m: { id: string }) => m.id !== "poolside/laguna-s-2.1") };
    vi.stubGlobal("fetch", fetchOk(modified));
    await cat.syncOpenRouterCatalog();

    const gone = cat.checkJobModel("openrouter:poolside/laguna-s-2.1");
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.reason).toContain("no longer offered");
  });
});

describe("getOpenRouterUsage", () => {
  it("returns null when no key is connected", async () => {
    const cat = await loadModule();
    expect(await cat.getOpenRouterUsage()).toBeNull();
  });

  it("maps the key response and caches it for a minute", async () => {
    writeFileSync(
      join(dir, "providers.json"),
      JSON.stringify([
        {
          id: "openrouter",
          name: "OpenRouter",
          isBuiltin: true,
          models: [],
          envVars: { ANTHROPIC_AUTH_TOKEN: "sk-or-x" },
          enabledModels: [],
        },
      ]),
    );
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          usage: 12.5,
          usage_daily: 0.4,
          usage_weekly: 2.1,
          usage_monthly: 9.9,
          limit: 20,
          limit_remaining: 7.5,
          is_free_tier: false,
        },
      }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchSpy);

    const cat = await loadModule();
    const usage = await cat.getOpenRouterUsage();
    expect(usage).toEqual({
      usage: 12.5,
      usageDaily: 0.4,
      usageWeekly: 2.1,
      usageMonthly: 9.9,
      limit: 20,
      limitRemaining: 7.5,
      isFreeTier: false,
    });

    await cat.getOpenRouterUsage();
    expect(vi.mocked(fetchSpy)).toHaveBeenCalledTimes(1);
  });

  it("throws on an upstream error", async () => {
    writeFileSync(
      join(dir, "providers.json"),
      JSON.stringify([
        {
          id: "openrouter",
          name: "OpenRouter",
          isBuiltin: true,
          models: [],
          envVars: { ANTHROPIC_AUTH_TOKEN: "sk-or-x" },
          enabledModels: [],
        },
      ]),
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch);
    const cat = await loadModule();
    await expect(cat.getOpenRouterUsage()).rejects.toThrow("HTTP 401");
  });
});

describe("ensureCatalogFresh", () => {
  it("skips when the cache is fresh", async () => {
    const cat = await loadModule();
    const fetchSpy = fetchOk(FIXTURE);
    vi.stubGlobal("fetch", fetchSpy);
    await cat.syncOpenRouterCatalog();
    expect(vi.mocked(fetchSpy)).toHaveBeenCalledTimes(1);

    cat.ensureCatalogFresh();
    expect(vi.mocked(fetchSpy)).toHaveBeenCalledTimes(1);
  });

  it("kicks a background resync when the cache is older than a day", async () => {
    const cat = await loadModule();
    writeFileSync(
      join(dir, "provider-catalog.json"),
      JSON.stringify({ syncedAt: Date.now() - 25 * 60 * 60 * 1000, consecutiveFailures: 0, models: [], delisted: [] }),
    );
    const fetchSpy = fetchOk(FIXTURE);
    vi.stubGlobal("fetch", fetchSpy);
    cat.ensureCatalogFresh();
    await vi.waitFor(() => expect(vi.mocked(fetchSpy)).toHaveBeenCalledTimes(1));
  });
});
