import { describe, expect, it } from "vitest";
import {
  allowedEffortLevels,
  cliModelWithContext,
  coerceEffort,
  defaultForAlias,
  describeModelSelection,
  describeProviderModel,
  findModelById,
  MODELS,
  modelOneMRequiresCredits,
  recommendedEffort,
  resolveModel,
  resolveProviderId,
  versionsForAlias,
} from "@/lib/models";
import type { ProviderModel } from "@/types";

describe("findModelById", () => {
  it("returns undefined for undefined input", () => {
    expect(findModelById(undefined)).toBeUndefined();
  });

  it("returns undefined for null input", () => {
    expect(findModelById(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(findModelById("")).toBeUndefined();
  });

  it("returns undefined for non-existent model", () => {
    expect(findModelById("claude-nonexistent")).toBeUndefined();
  });

  it("finds model by exact modelId", () => {
    const model = findModelById("claude-haiku-4-5-20251001");
    expect(model).toBeDefined();
    expect(model?.alias).toBe("haiku");
  });

  it("finds opus 4.6 by modelId", () => {
    const model = findModelById("claude-opus-4-6");
    expect(model).toBeDefined();
    expect(model?.version).toBe("4.6");
  });

  it("finds sonnet by modelId", () => {
    const model = findModelById("claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model?.displayName).toBe("Sonnet 4.6");
  });
});

describe("versionsForAlias", () => {
  it("returns haiku versions", () => {
    const versions = versionsForAlias("haiku");
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe("4.5");
  });

  it("returns sonnet versions", () => {
    const versions = versionsForAlias("sonnet");
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe("4.6");
    expect(versions[1].version).toBe("5");
  });

  it("returns multiple opus versions", () => {
    const versions = versionsForAlias("opus");
    expect(versions).toHaveLength(4);
    expect(versions[0].version).toBe("4.6");
    expect(versions[1].version).toBe("4.7");
    expect(versions[2].version).toBe("4.8");
    expect(versions[3].version).toBe("5");
  });

  it("returns empty array for non-existent alias", () => {
    const versions = versionsForAlias("nonexistent" as any);
    expect(versions).toHaveLength(0);
  });

  it("returns all entries in MODELS order", () => {
    const opusVersions = versionsForAlias("opus");
    const opusInModels = MODELS.filter((m) => m.alias === "opus");
    expect(opusVersions).toEqual(opusInModels);
  });
});

describe("defaultForAlias", () => {
  it("returns default haiku model", () => {
    const model = defaultForAlias("haiku");
    expect(model).toBeDefined();
    expect(model?.isDefault).toBe(true);
  });

  it("returns default sonnet model", () => {
    const model = defaultForAlias("sonnet");
    expect(model).toBeDefined();
    expect(model?.isDefault).toBe(true);
  });

  it("returns default opus model (5)", () => {
    const model = defaultForAlias("opus");
    expect(model).toBeDefined();
    expect(model?.version).toBe("5");
    expect(model?.isDefault).toBe(true);
  });

  it("returns the default-flagged entry even if not first in array", () => {
    const result = defaultForAlias("opus");
    expect(result?.isDefault).toBe(true);
    expect(result?.modelId).toBe("claude-opus-5");
  });
});

describe("resolveModel", () => {
  it("returns null for undefined input", () => {
    expect(resolveModel(undefined)).toBeNull();
  });

  it("returns null for null input", () => {
    expect(resolveModel(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(resolveModel("")).toBeNull();
  });

  it("resolves 'haiku' alias to default haiku", () => {
    const model = resolveModel("haiku");
    expect(model?.alias).toBe("haiku");
    expect(model?.isDefault).toBe(true);
  });

  it("resolves 'sonnet' alias to default sonnet", () => {
    const model = resolveModel("sonnet");
    expect(model?.alias).toBe("sonnet");
  });

  it("resolves 'opus' alias to default opus", () => {
    const model = resolveModel("opus");
    expect(model?.alias).toBe("opus");
    expect(model?.version).toBe("5");
  });

  it("strips [bracket] suffix from alias", () => {
    const model = resolveModel("haiku[some-suffix]");
    expect(model?.alias).toBe("haiku");
  });

  it("strips complex [bracket] suffix", () => {
    const model = resolveModel("sonnet[v1-extra-data]");
    expect(model?.alias).toBe("sonnet");
  });

  it("resolves by modelId when not an alias", () => {
    const model = resolveModel("claude-haiku-4-5-20251001");
    expect(model?.alias).toBe("haiku");
  });

  it("resolves by modelId for opus 4.6", () => {
    const model = resolveModel("claude-opus-4-6");
    expect(model?.version).toBe("4.6");
  });

  it("returns null for invalid modelId", () => {
    expect(resolveModel("invalid-model-id")).toBeNull();
  });

  it("strips suffix before checking modelId", () => {
    const model = resolveModel("claude-sonnet-4-6[test]");
    expect(model?.alias).toBe("sonnet");
  });
});

describe("allowedEffortLevels", () => {
  it("returns empty array for null entry", () => {
    expect(allowedEffortLevels(null)).toEqual([]);
  });

  it("returns empty array for undefined entry", () => {
    expect(allowedEffortLevels(undefined)).toEqual([]);
  });

  it("returns empty array for haiku", () => {
    const haiku = MODELS.find((m) => m.alias === "haiku")!;
    expect(allowedEffortLevels(haiku)).toEqual([]);
  });

  it("returns [low, medium, high, max] for sonnet", () => {
    const sonnet = MODELS.find((m) => m.alias === "sonnet")!;
    expect(allowedEffortLevels(sonnet)).toEqual(["low", "medium", "high", "max"]);
  });

  it("returns [low, medium, high, max] for opus 4.6", () => {
    const opus46 = MODELS.find((m) => m.alias === "opus" && m.version === "4.6")!;
    expect(allowedEffortLevels(opus46)).toEqual(["low", "medium", "high", "max"]);
  });

  it("returns [low, medium, high, xhigh, max] for opus 4.7", () => {
    const opus47 = MODELS.find((m) => m.alias === "opus" && m.version === "4.7")!;
    expect(allowedEffortLevels(opus47)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("returns [low, medium, high, xhigh, max] for opus 4.8", () => {
    const opus48 = MODELS.find((m) => m.alias === "opus" && m.version === "4.8")!;
    expect(allowedEffortLevels(opus48)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("recommendedEffort", () => {
  it("returns null for null entry", () => {
    expect(recommendedEffort(null)).toBeNull();
  });

  it("returns null for undefined entry", () => {
    expect(recommendedEffort(undefined)).toBeNull();
  });

  it("returns null for haiku", () => {
    const haiku = MODELS.find((m) => m.alias === "haiku")!;
    expect(recommendedEffort(haiku)).toBeNull();
  });

  it("returns 'xhigh' for opus 4.7", () => {
    const opus47 = MODELS.find((m) => m.alias === "opus" && m.version === "4.7")!;
    expect(recommendedEffort(opus47)).toBe("xhigh");
  });

  it("returns 'xhigh' for opus 4.8", () => {
    const opus48 = MODELS.find((m) => m.alias === "opus" && m.version === "4.8")!;
    expect(recommendedEffort(opus48)).toBe("xhigh");
  });

  it("returns 'medium' for sonnet", () => {
    const sonnet = MODELS.find((m) => m.alias === "sonnet")!;
    expect(recommendedEffort(sonnet)).toBe("medium");
  });

  it("returns 'high' for opus 4.6", () => {
    const opus46 = MODELS.find((m) => m.alias === "opus" && m.version === "4.6")!;
    expect(recommendedEffort(opus46)).toBe("high");
  });
});

describe("coerceEffort", () => {
  const haiku = MODELS.find((m) => m.alias === "haiku")!;
  const sonnet = MODELS.find((m) => m.alias === "sonnet")!;
  const opus46 = MODELS.find((m) => m.alias === "opus" && m.version === "4.6")!;
  const opus47 = MODELS.find((m) => m.alias === "opus" && m.version === "4.7")!;

  it("returns null for null entry", () => {
    expect(coerceEffort("low", null)).toBeNull();
  });

  it("returns null for undefined entry", () => {
    expect(coerceEffort("low", undefined)).toBeNull();
  });

  it("returns null for haiku (no allowed levels)", () => {
    expect(coerceEffort("low", haiku)).toBeNull();
    expect(coerceEffort("medium", haiku)).toBeNull();
  });

  it("returns level if allowed for sonnet", () => {
    expect(coerceEffort("low", sonnet)).toBe("low");
    expect(coerceEffort("medium", sonnet)).toBe("medium");
    expect(coerceEffort("high", sonnet)).toBe("high");
    expect(coerceEffort("max", sonnet)).toBe("max");
  });

  it("returns recommended if level not allowed for sonnet", () => {
    expect(coerceEffort("xhigh", sonnet)).toBe("medium");
  });

  it("returns level if allowed for opus 4.7", () => {
    expect(coerceEffort("low", opus47)).toBe("low");
    expect(coerceEffort("xhigh", opus47)).toBe("xhigh");
  });

  it("returns recommended if level not allowed for opus 4.7", () => {
    const _levels = allowedEffortLevels(opus47);
    expect(coerceEffort("other" as any, opus47)).toBe("xhigh");
  });

  it("falls back to recommended when level is not allowed", () => {
    expect(coerceEffort("xhigh", opus46)).toBe("high");
  });

  it("returns allowed level for opus 4.6", () => {
    expect(coerceEffort("low", opus46)).toBe("low");
    expect(coerceEffort("max", opus46)).toBe("max");
  });

  it("returns recommended for opus 4.6 when level not allowed", () => {
    expect(coerceEffort("xhigh", opus46)).toBe("high");
  });
});

describe("resolveProviderId", () => {
  const providers = [
    { id: "anthropic", models: [{ modelId: "claude-sonnet-4-6" }] },
    { id: "custom", models: [{ modelId: "some-model" }] },
  ];

  it("resolves prefixed model to custom provider", () => {
    expect(resolveProviderId("custom:some-model", providers)).toBe("custom");
  });

  it("resolves prefixed model with suffix to custom provider", () => {
    expect(resolveProviderId("custom:some-model[1m]", providers)).toBe("custom");
  });

  it("resolves bare anthropic model to anthropic", () => {
    expect(resolveProviderId("claude-sonnet-4-6", providers)).toBe("anthropic");
  });

  it("falls back to anthropic for nonexistent model", () => {
    expect(resolveProviderId("nonexistent", providers)).toBe("anthropic");
  });

  it("falls back to anthropic when providers is undefined", () => {
    expect(resolveProviderId("custom:some-model", undefined)).toBe("anthropic");
  });

  it("falls back to anthropic when providers is empty array", () => {
    expect(resolveProviderId("custom:some-model", [])).toBe("anthropic");
  });
});

describe("describeModelSelection", () => {
  const customProviders: { id: string; models: ProviderModel[] }[] = [
    {
      id: "lmstudio",
      models: [{ modelId: "gpt-oss-20b", displayName: "GPT-OSS 20B", effortLevels: ["low", "high"], contextSizes: ["200k", "1m"] }],
    },
  ];

  it("labels a built-in opus, keeps an allowed thinking level, and reports the context size", () => {
    expect(describeModelSelection("opus", "max", "200k", undefined)).toEqual({ label: "Opus 5", thinking: "max", context: "200k" });
  });

  it("reports 1M context when selected on a multi-size model", () => {
    expect(describeModelSelection("opus", "high", "1m", undefined)).toEqual({ label: "Opus 5", thinking: "high", context: "1m" });
  });

  it("drops thinking for a model with none (haiku) and omits context for a single-size model", () => {
    expect(describeModelSelection("haiku", "high", "200k", undefined)).toEqual({ label: "Haiku 4.5", thinking: null, context: null });
  });

  it("drops xhigh for a model that does not allow it (sonnet 4.6) but keeps context", () => {
    expect(describeModelSelection("claude-sonnet-4-6", "xhigh", "200k", undefined)).toEqual({
      label: "Sonnet 4.6",
      thinking: null,
      context: "200k",
    });
  });

  it("resolves a built-in by exact modelId", () => {
    expect(describeModelSelection("claude-opus-4-7", "xhigh", "1m", undefined)).toEqual({
      label: "Opus 4.7",
      thinking: "xhigh",
      context: "1m",
    });
  });

  it("strips a [context] suffix before resolving", () => {
    expect(describeModelSelection("sonnet[1m]", "medium", "200k", undefined)).toEqual({
      label: "Sonnet 5",
      thinking: "medium",
      context: "200k",
    });
  });

  it("labels a custom provider model by displayName and honours its effortLevels and sizes", () => {
    expect(describeModelSelection("lmstudio:gpt-oss-20b", "high", "1m", customProviders)).toEqual({
      label: "GPT-OSS 20B",
      thinking: "high",
      context: "1m",
    });
    expect(describeModelSelection("lmstudio:gpt-oss-20b", "max", "200k", customProviders)).toEqual({
      label: "GPT-OSS 20B",
      thinking: null,
      context: "200k",
    });
  });

  it("matches a custom provider model by bare modelId too", () => {
    expect(describeModelSelection("gpt-oss-20b", "low", "200k", customProviders)).toEqual({
      label: "GPT-OSS 20B",
      thinking: "low",
      context: "200k",
    });
  });

  it("omits context for a single-size custom model", () => {
    const single: { id: string; models: ProviderModel[] }[] = [
      { id: "lm", models: [{ modelId: "m", displayName: "M", effortLevels: [], contextSizes: ["200k"] }] },
    ];
    expect(describeModelSelection("lm:m", "low", "200k", single)).toEqual({ label: "M", thinking: null, context: null });
  });

  it("strips a provider prefix and shows no thinking or context for an unknown model", () => {
    expect(describeModelSelection("ghost:some-model", "high", "1m", [])).toEqual({ label: "some-model", thinking: null, context: null });
  });

  it("shows off for a custom model that declares effort levels", () => {
    const providers: { id: string; models: ProviderModel[] }[] = [
      { id: "lm", models: [{ modelId: "m", displayName: "M", effortLevels: ["low", "high"], contextSizes: ["200k"] }] },
    ];
    expect(describeModelSelection("lm:m", "off", "200k", providers).thinking).toBe("off");
  });
});

// Powers the provider/model lines on the scheduled-job cards, which name both
// rather than showing one pill.
describe("describeProviderModel", () => {
  const providers = [
    {
      id: "zen-go",
      name: "OpenCode Go",
      models: [
        { modelId: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", effortLevels: [], contextSizes: ["200k"] as const },
      ] as ProviderModel[],
    },
  ];

  it("names Anthropic for an alias and for an exact model id", () => {
    expect(describeProviderModel("sonnet", undefined)).toEqual({ provider: "Anthropic", model: "Sonnet 5" });
    expect(describeProviderModel("claude-opus-4-7", undefined)).toEqual({ provider: "Anthropic", model: "Opus 4.7" });
  });

  it("uses the provider's own name and the model's display name", () => {
    expect(describeProviderModel("zen-go:deepseek-v4-flash", providers)).toEqual({
      provider: "OpenCode Go",
      model: "DeepSeek V4 Flash",
    });
  });

  it("strips a [1m] suffix before resolving", () => {
    expect(describeProviderModel("sonnet[1m]", undefined)).toEqual({ provider: "Anthropic", model: "Sonnet 5" });
  });

  // A job outlives the provider it was set up against, and a card that goes
  // blank hides which model the job is still set to run.
  it("falls back to the raw ids for a disconnected provider or delisted model", () => {
    expect(describeProviderModel("zen-go:some-new-model", providers)).toEqual({ provider: "OpenCode Go", model: "some-new-model" });
    expect(describeProviderModel("ghost:m", [])).toEqual({ provider: "ghost", model: "m" });
  });

  // The run would fall back to a default this helper cannot know, and naming
  // the wrong model is worse than naming none.
  it("returns null for an unset model", () => {
    expect(describeProviderModel(undefined, providers)).toBeNull();
    expect(describeProviderModel("", providers)).toBeNull();
  });
});

describe("Fable 5.1", () => {
  it("is the default fable, resolvable by alias and modelId", () => {
    expect(resolveModel("fable")?.modelId).toBe("claude-fable-5-1");
    expect(resolveModel("claude-fable-5-1")?.alias).toBe("fable");
    expect(findModelById("claude-fable-5-1")?.displayName).toBe("Fable 5.1");
    expect(defaultForAlias("fable")?.modelId).toBe("claude-fable-5-1");
  });

  // Sessions pinned to the older id keep running on it; only the bare alias moves.
  it("leaves Fable 5 selectable but no longer the default", () => {
    expect(findModelById("claude-fable-5")?.displayName).toBe("Fable 5");
    expect(findModelById("claude-fable-5")?.isDefault).toBeUndefined();
    expect(versionsForAlias("fable").map((m) => m.version)).toEqual(["5", "5.1"]);
  });

  it("supports the full effort range including xhigh and max", () => {
    expect(allowedEffortLevels(resolveModel("fable"))).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(allowedEffortLevels(findModelById("claude-fable-5"))).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("Sonnet 5", () => {
  it("is the default sonnet, resolvable by alias and modelId", () => {
    expect(resolveModel("sonnet")?.modelId).toBe("claude-sonnet-5");
    expect(resolveModel("claude-sonnet-5")?.alias).toBe("sonnet");
    expect(findModelById("claude-sonnet-5")?.displayName).toBe("Sonnet 5");
    expect(defaultForAlias("sonnet")?.modelId).toBe("claude-sonnet-5");
  });

  it("supports xhigh and max effort, unlike Sonnet 4.6", () => {
    expect(allowedEffortLevels(resolveModel("claude-sonnet-5"))).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(recommendedEffort(resolveModel("claude-sonnet-5"))).toBe("xhigh");
    // Sonnet 4.6 stays available and still lacks xhigh.
    expect(allowedEffortLevels(resolveModel("claude-sonnet-4-6"))).toEqual(["low", "medium", "high", "max"]);
  });
});

describe("Opus 5", () => {
  it("is the default opus, resolvable by alias and modelId", () => {
    expect(resolveModel("opus")?.modelId).toBe("claude-opus-5");
    expect(resolveModel("claude-opus-5")?.alias).toBe("opus");
    expect(findModelById("claude-opus-5")?.displayName).toBe("Opus 5");
    expect(defaultForAlias("opus")?.modelId).toBe("claude-opus-5");
  });

  it("supports the full effort range including xhigh and max", () => {
    expect(allowedEffortLevels(resolveModel("claude-opus-5"))).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(recommendedEffort(resolveModel("claude-opus-5"))).toBe("xhigh");
  });

  it("has an included 1M window, so the id stays bare at 1M", () => {
    expect(modelOneMRequiresCredits("claude-opus-5")).toBe(false);
    expect(cliModelWithContext("claude-opus-5", "1m", true)).toBe("claude-opus-5");
    expect(findModelById("claude-opus-5")?.contextSizes).toEqual(["200k", "1m"]);
  });

  it("leaves Opus 4.8 available as a non-default previous generation", () => {
    expect(findModelById("claude-opus-4-8")?.displayName).toBe("Opus 4.8");
    expect(findModelById("claude-opus-4-8")?.isDefault).toBeUndefined();
  });
});

describe("modelOneMRequiresCredits", () => {
  it("is true only for Sonnet 4.6 (its 1M is credit-gated)", () => {
    expect(modelOneMRequiresCredits("claude-sonnet-4-6")).toBe(true);
    expect(modelOneMRequiresCredits("claude-opus-4-8")).toBe(false);
    expect(modelOneMRequiresCredits("claude-sonnet-5")).toBe(false);
    expect(modelOneMRequiresCredits("claude-fable-5")).toBe(false);
    expect(modelOneMRequiresCredits("claude-fable-5-1")).toBe(false);
    expect(modelOneMRequiresCredits("haiku")).toBe(false);
  });

  it("is false for unknown/custom models and nullish input", () => {
    expect(modelOneMRequiresCredits("custom:foo")).toBe(false);
    expect(modelOneMRequiresCredits(undefined)).toBe(false);
    expect(modelOneMRequiresCredits(null)).toBe(false);
  });
});

describe("cliModelWithContext", () => {
  it("appends [1m] only for a credit-gated model at 1M with opt-in", () => {
    expect(cliModelWithContext("claude-sonnet-4-6", "1m", true)).toBe("claude-sonnet-4-6[1m]");
  });

  it("leaves the id bare when the opt-in is off", () => {
    expect(cliModelWithContext("claude-sonnet-4-6", "1m", false)).toBe("claude-sonnet-4-6");
  });

  it("leaves the id bare at 200k regardless of opt-in", () => {
    expect(cliModelWithContext("claude-sonnet-4-6", "200k", true)).toBe("claude-sonnet-4-6");
  });

  it("never appends [1m] for models whose 1M is free (Opus 4.8, Sonnet 5)", () => {
    expect(cliModelWithContext("claude-opus-4-8", "1m", true)).toBe("claude-opus-4-8");
    expect(cliModelWithContext("claude-sonnet-5", "1m", true)).toBe("claude-sonnet-5");
  });

  it("leaves custom-provider ids untouched", () => {
    expect(cliModelWithContext("prov:some-model", "1m", true)).toBe("prov:some-model");
  });
});

describe('thinking "off"', () => {
  it("coerceEffort keeps off for thinking-capable models and drops it for haiku", () => {
    expect(coerceEffort("off", resolveModel("opus"))).toBe("off");
    expect(coerceEffort("off", resolveModel("fable"))).toBe("off");
    expect(coerceEffort("off", resolveModel("haiku"))).toBeNull();
  });

  it("describeModelSelection shows off for thinking-capable models, nothing for haiku", () => {
    expect(describeModelSelection("opus", "off", "200k", undefined).thinking).toBe("off");
    expect(describeModelSelection("fable", "off", "1m", undefined)).toEqual({ label: "Fable 5.1", thinking: "off", context: "1m" });
    expect(describeModelSelection("haiku", "off", "200k", undefined).thinking).toBeNull();
  });
});
