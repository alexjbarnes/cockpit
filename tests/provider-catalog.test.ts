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
    // The audio model is gone entirely now, not merely unbadged: it lists no
    // "tools" parameter, and the CLI sends tool definitions on every request,
    // so a session on it can only ever fail. See the tool filter below.
    expect(byId.get("google/lyria-3-pro-preview")).toBeUndefined();

    expect(byId.get("poolside/laguna-m.1:free")?.expirationDate).toBe("2026-07-28");
    expect(byId.get("nvidia/nemotron-nano-12b-v2-vl:free")?.supportsImageInput).toBe(true);
    // reasoning-capable catalog models expose the effort ladder; the
    // Anthropic-style context enum stays empty (raw contextLength instead)
    expect(nemotron?.effortLevels).toEqual(["low", "medium", "high"]);
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

  // The reported failure: a session on z-ai/glm-5.2:free died with "There's an
  // issue with the selected model ... It may not exist or you may not have
  // access to it". The model existed and the key was fine. Its one endpoint
  // (Decart) does not accept tools, and the CLI sends tool definitions on every
  // request, so OpenRouter answered 404 and the CLI blamed the model. 68 of the
  // 414 synced entries were in that state.
  it("drops a model whose endpoint will not accept tools", async () => {
    const cat = await loadModule();
    const mapped = cat.mapOpenRouterModel({
      id: "z-ai/glm-5.2:free",
      name: "Z.ai: GLM 5.2 (free)",
      context_length: 128000,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["max_tokens", "reasoning", "temperature", "top_p"],
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    });
    expect(mapped).toBeNull();
  });

  it("keeps the tool-capable variant of the same family", async () => {
    // Per variant, not per family: the paid z-ai/glm-5.2 routes to several
    // tool-capable endpoints, which is why the family's page reads as
    // tool-enabled while the free slice cannot work.
    const cat = await loadModule();
    const mapped = cat.mapOpenRouterModel({
      id: "z-ai/glm-5.2",
      context_length: 1048576,
      pricing: { prompt: "0.0000004", completion: "0.0000016" },
      supported_parameters: ["tools", "reasoning", "temperature"],
      architecture: { output_modalities: ["text"] },
    });
    expect(mapped?.modelId).toBe("z-ai/glm-5.2");
    expect(mapped?.supportsTools).toBe(true);
  });

  it("hides an already-synced tool-incapable model without waiting for a resync", async () => {
    const cat = await loadModule();
    const { writeFileSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    // A catalog written by a version that had no tool filter.
    writeFileSync(
      joinPath(dir, "provider-catalog.json"),
      JSON.stringify({
        syncedAt: Date.now(),
        consecutiveFailures: 0,
        delisted: [],
        models: [
          { modelId: "vendor/works", displayName: "works", effortLevels: [], contextSizes: [], contextLength: 1000, supportsTools: true },
          { modelId: "vendor/no-tools", displayName: "no", effortLevels: [], contextSizes: [], contextLength: 1000, supportsTools: false },
          { modelId: "vendor/unknown", displayName: "unk", effortLevels: [], contextSizes: [], contextLength: 1000 },
        ],
      }),
    );

    const ids = cat.catalogModels().map((m) => m.modelId);
    expect(ids).toContain("vendor/works");
    expect(ids, "the pickers must stop offering it immediately").not.toContain("vendor/no-tools");
    expect(ids, "undefined is not false: metadata that never carried the flag keeps its models").toContain("vendor/unknown");
  });

  it("exposes effort levels only for reasoning-capable models", async () => {
    const cat = await loadModule();
    const reasoning = cat.mapOpenRouterModel({
      id: "vendor/thinker",
      pricing: { prompt: "0.000001", completion: "0.000002" },
      supported_parameters: ["tools", "reasoning"],
      architecture: { output_modalities: ["text"] },
    });
    expect(reasoning?.effortLevels).toEqual(["low", "medium", "high"]);
    const plain = cat.mapOpenRouterModel({
      id: "vendor/plain",
      pricing: { prompt: "0.000001", completion: "0.000002" },
      supported_parameters: ["tools"],
      architecture: { output_modalities: ["text"] },
    });
    expect(plain?.effortLevels).toEqual([]);
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

  it("judges zen and deepseek ids against their stored model lists", async () => {
    writeFileSync(
      join(dir, "providers.json"),
      JSON.stringify([
        { id: "zen", isBuiltin: true, envVars: {}, models: [{ modelId: "big-pickle" }] },
        { id: "deepseek", isBuiltin: true, envVars: {}, models: [{ modelId: "deepseek-v4-flash" }] },
      ]),
    );
    const cat = await loadModule();
    expect(cat.checkJobModel("zen:big-pickle").ok).toBe(true);
    expect(cat.checkJobModel("deepseek:deepseek-v4-flash").ok).toBe(true);
    const missing = cat.checkJobModel("zen:gone-model");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("OpenCode Zen");
    const ds = cat.checkJobModel("deepseek:deepseek-chat");
    expect(ds.ok).toBe(false);
    if (!ds.ok) expect(ds.reason).toContain("DeepSeek");
  });

  it("passes zen/deepseek ids before a first sync or without providers.json", async () => {
    const cat = await loadModule();
    // no providers.json at all
    expect(cat.checkJobModel("zen:anything").ok).toBe(true);
    // entry exists but has never synced a model list
    writeFileSync(join(dir, "providers.json"), JSON.stringify([{ id: "deepseek", isBuiltin: true, envVars: {}, models: [] }]));
    expect(cat.checkJobModel("deepseek:deepseek-v4-flash").ok).toBe(true);
  });

  it("judges zen-go ids against its stored model list, distinct from zen's", async () => {
    writeFileSync(
      join(dir, "providers.json"),
      JSON.stringify([
        { id: "zen", isBuiltin: true, envVars: {}, models: [{ modelId: "big-pickle" }] },
        { id: "zen-go", isBuiltin: true, envVars: {}, models: [{ modelId: "grok-code-fast-2" }] },
      ]),
    );
    const cat = await loadModule();
    expect(cat.checkJobModel("zen-go:grok-code-fast-2").ok).toBe(true);
    // a zen-go id is not confused with the plain zen entry's list, and vice versa
    expect(cat.checkJobModel("zen-go:big-pickle").ok).toBe(false);
    expect(cat.checkJobModel("zen:grok-code-fast-2").ok).toBe(false);
    const missing = cat.checkJobModel("zen-go:gone-model");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("OpenCode Go");
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
