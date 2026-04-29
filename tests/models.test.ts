import { describe, expect, it } from "vitest";
import {
  allowedEffortLevels,
  coerceEffort,
  defaultForAlias,
  findModelById,
  MODELS,
  recommendedEffort,
  resolveModel,
  versionsForAlias,
} from "@/lib/models";

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
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe("4.6");
  });

  it("returns multiple opus versions", () => {
    const versions = versionsForAlias("opus");
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe("4.6");
    expect(versions[1].version).toBe("4.7");
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

  it("returns default opus model (4.7)", () => {
    const model = defaultForAlias("opus");
    expect(model).toBeDefined();
    expect(model?.version).toBe("4.7");
    expect(model?.isDefault).toBe(true);
  });

  it("returns the default-flagged entry even if not first in array", () => {
    const result = defaultForAlias("opus");
    expect(result?.isDefault).toBe(true);
    expect(result?.modelId).toBe("claude-opus-4-7");
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
    expect(model?.version).toBe("4.7");
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
