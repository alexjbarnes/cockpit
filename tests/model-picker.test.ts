// The session settings' Model tab: what the "Thinking & context" view offers
// for the current model, and what the "Model" list shows for a provider filter
// and a search.
import { describe, expect, it } from "vitest";
import {
  ALL_PROVIDERS,
  defaultSelectionFor,
  filterPicker,
  MODEL_ALIASES,
  modelMatches,
  modelTuning,
  parseCurrentModel,
  pickerGroups,
  providerOptions,
  selectionSummary,
  valueForAlias,
  valueForEntry,
} from "@/lib/model-picker";
import { defaultForAlias, findModelById, versionsForAlias } from "@/lib/models";
import type { Provider, ProviderModel } from "@/types";

function model(modelId: string, extra: Partial<ProviderModel> = {}): ProviderModel {
  return { modelId, displayName: modelId, effortLevels: [], contextSizes: [], ...extra };
}

function provider(id: string, models: ProviderModel[], extra: Partial<Provider> = {}): Provider {
  return { id, name: `${id} name`, envVars: {}, models, ...extra };
}

describe("parseCurrentModel", () => {
  it("reads an alias as its default version, with or without a context suffix", () => {
    expect(parseCurrentModel("opus", "1m")).toEqual({ alias: "opus", entry: defaultForAlias("opus"), contextSize: "1m" });
    expect(parseCurrentModel("sonnet[1m]", "200k").alias).toBe("sonnet");
  });

  it("reads a full catalogue id as its own entry", () => {
    const parsed = parseCurrentModel("claude-opus-4-8", "200k");
    expect(parsed.alias).toBe("opus");
    expect(parsed.entry?.modelId).toBe("claude-opus-4-8");
  });

  it("knows nothing of a provider's model", () => {
    expect(parseCurrentModel("zen:kimi-k3", "200k")).toEqual({ alias: null, entry: null, contextSize: "200k" });
  });
});

describe("valueForEntry and valueForAlias", () => {
  it("store a version of a many-versioned alias by its full id", () => {
    const entry = findModelById("claude-opus-4-8");
    expect(entry).toBeDefined();
    expect(valueForEntry(entry as NonNullable<typeof entry>)).toBe("claude-opus-4-8");
  });

  it("store a picked alias as its default version", () => {
    expect(valueForAlias("opus")).toBe(defaultForAlias("opus")?.modelId);
  });
});

describe("defaultSelectionFor", () => {
  const zen = provider("zen", [
    model("kimi-k3", { effortLevels: ["medium", "high"], contextSizes: ["200k", "1m"] }),
    model("ds-free", { effortLevels: [], contextSizes: ["200k"] }),
  ]);

  it("stores a provider's model with the context size it already has", () => {
    expect(defaultSelectionFor("zen:kimi-k3", { contextSize: "1m", thinkingLevel: "high" }, [zen])).toEqual({
      model: "zen:kimi-k3",
      contextSize: "1m",
      thinkingLevel: "high",
    });
  });

  it("falls back to a size the new model offers", () => {
    const narrow = provider("zen", [model("kimi-k3", { contextSizes: ["200k"] })]);
    expect(defaultSelectionFor("zen:kimi-k3", { contextSize: "1m", thinkingLevel: "high" }, [narrow]).contextSize).toBe("200k");
  });

  it("settles thinking on a level the provider's model offers", () => {
    expect(defaultSelectionFor("zen:kimi-k3", { contextSize: "200k", thinkingLevel: "xhigh" }, [zen]).thinkingLevel).toBe("high");
    // "off" is a choice, not a missing level, and every thinking model accepts it.
    expect(defaultSelectionFor("zen:kimi-k3", { contextSize: "200k", thinkingLevel: "off" }, [zen]).thinkingLevel).toBe("off");
  });

  it("leaves thinking alone for a model that has none", () => {
    expect(defaultSelectionFor("zen:ds-free", { contextSize: "200k", thinkingLevel: "high" }, [zen]).thinkingLevel).toBe("high");
  });

  it("recommends a level for an Anthropic model that cannot run the current one", () => {
    // Sonnet 4.6 has no xhigh; its recommendation is medium.
    expect(defaultSelectionFor("claude-sonnet-4-6", { contextSize: "200k", thinkingLevel: "xhigh" }, undefined).thinkingLevel).toBe(
      "medium",
    );
  });

  it("keeps a level the Anthropic model can run", () => {
    expect(defaultSelectionFor("opus", { contextSize: "200k", thinkingLevel: "low" }, undefined).thinkingLevel).toBe("low");
  });
});

describe("modelTuning", () => {
  it("offers an alias's versions, its context sizes and its thinking levels, off first", () => {
    const tuning = modelTuning("opus", "200k", undefined);
    expect(tuning.versions).toEqual(versionsForAlias("opus"));
    expect(tuning.contextSizes).toEqual(defaultForAlias("opus")?.contextSizes);
    expect(tuning.thinkingLevels[0].value).toBe("off");
    expect(tuning.thinkingLevels.map((t) => t.value)).toContain("max");
  });

  it("holds back a 1M window that needs usage credits until they are opted into", () => {
    const entry = findModelById("claude-sonnet-4-6");
    expect(entry?.oneMRequiresCredits).toBe(true);
    expect(modelTuning("claude-sonnet-4-6", "1m", undefined, false).contextSizes).not.toContain("1m");
    expect(modelTuning("claude-sonnet-4-6", "1m", undefined, true).contextSizes).toContain("1m");
  });

  it("offers no thinking for a model that cannot think", () => {
    expect(modelTuning("claude-haiku-4-5-20251001", "200k", undefined).thinkingLevels).toEqual([]);
  });

  it("takes a provider's model's sizes and levels from the provider, by qualified or bare id", () => {
    const providers = [provider("zen", [model("kimi-k3", { effortLevels: ["low", "high"], contextSizes: ["200k", "1m"] })])];
    for (const id of ["zen:kimi-k3", "kimi-k3"]) {
      const tuning = modelTuning(id, "200k", providers);
      expect(tuning.versions).toEqual([]);
      expect(tuning.contextSizes).toEqual(["200k", "1m"]);
      expect(tuning.thinkingLevels.map((t) => t.value)).toEqual(["off", "low", "high"]);
    }
  });

  it("survives a provider entry that predates contextSizes and effortLevels", () => {
    const legacy = { modelId: "old", displayName: "Old" } as ProviderModel;
    const tuning = modelTuning("legacy:old", "200k", [provider("legacy", [legacy])]);
    expect(tuning.contextSizes).toEqual([]);
    expect(tuning.thinkingLevels).toEqual([]);
  });

  it("offers nothing for a model no one serves", () => {
    const tuning = modelTuning("nowhere:x", "200k", [provider("zen", [model("kimi-k3")])]);
    expect(tuning).toMatchObject({ versions: [], contextSizes: [], thinkingLevels: [] });
    expect(modelTuning("", "200k", undefined).contextSizes).toEqual([]);
  });
});

describe("pickerGroups", () => {
  it("lists runnable providers only, each with the models it may offer", () => {
    const groups = pickerGroups([
      provider("anthropic", [model("claude-opus-4-8")]),
      provider("groq", [model("llama")], { isBuiltin: true }),
      provider("zen", [model("kimi-k3"), model("qwen")], { isBuiltin: true, envVars: { KEY: "x" }, enabledModels: ["kimi-k3"] }),
      provider("nim", [model("nemo")], { isBuiltin: true, envVars: { KEY: "x" }, enabledModels: [] }),
      provider("mine", [model("a"), model("b")]),
      provider("empty", []),
    ]);
    expect(groups.map((g) => [g.provider.id, g.models.map((m) => m.modelId)])).toEqual([
      ["zen", ["kimi-k3"]],
      ["mine", ["a", "b"]],
    ]);
    expect(pickerGroups(undefined)).toEqual([]);
  });
});

describe("modelMatches", () => {
  it("matches the id or the display name, whatever the case, and anything for an empty search", () => {
    const m = model("moonshot/kimi-k3", { displayName: "Kimi K3" });
    expect(modelMatches(m, "KIMI")).toBe(true);
    expect(modelMatches(m, "k3")).toBe(true);
    expect(modelMatches(model("x", { displayName: "Gemini Flash" }), "flash")).toBe(true);
    expect(modelMatches(m, "opus")).toBe(false);
    expect(modelMatches(m, "  ")).toBe(true);
  });
});

describe("filterPicker", () => {
  const groups = pickerGroups([provider("zen", [model("kimi-k3"), model("qwen")]), provider("groq", [model("llama")])]);

  it("shows everything, recent first, while nothing narrows it", () => {
    const list = filterPicker(groups, ALL_PROVIDERS, " ");
    expect(list.showRecent).toBe(true);
    expect(list.aliases).toEqual(MODEL_ALIASES);
    expect(list.groups.map((g) => g.provider.id)).toEqual(["zen", "groq"]);
  });

  it("drops recent while searching, and keeps only what matches", () => {
    const list = filterPicker(groups, ALL_PROVIDERS, "kimi");
    expect(list.showRecent).toBe(false);
    expect(list.aliases).toEqual([]);
    expect(list.groups.map((g) => [g.provider.id, g.models.map((m) => m.modelId)])).toEqual([["zen", ["kimi-k3"]]]);
    expect(filterPicker(groups, ALL_PROVIDERS, "op").aliases.map((a) => a.value)).toEqual(["opus"]);
  });

  it("narrows to one provider: Anthropic is the aliases, any other its own group", () => {
    const anthropic = filterPicker(groups, "anthropic", "");
    expect(anthropic).toMatchObject({ showRecent: false, aliases: MODEL_ALIASES, groups: [] });
    const zen = filterPicker(groups, "zen", "");
    expect(zen.aliases).toEqual([]);
    expect(zen.groups.map((g) => g.provider.id)).toEqual(["zen"]);
  });
});

describe("providerOptions", () => {
  it("counts what each choice lists, with everything first and Anthropic next", () => {
    const groups = pickerGroups([provider("zen", [model("a"), model("b")]), provider("groq", [model("c")])]);
    expect(providerOptions(groups)).toEqual([
      { id: ALL_PROVIDERS, name: "All providers", count: MODEL_ALIASES.length + 3 },
      { id: "anthropic", name: "Anthropic", count: MODEL_ALIASES.length },
      { id: "zen", name: "zen name", count: 2 },
      { id: "groq", name: "groq name", count: 1 },
    ]);
  });
});

describe("selectionSummary", () => {
  it("names a catalogue model's provider as Anthropic, with its context and thinking", () => {
    expect(selectionSummary({ label: "Opus 4.8", provider: null, thinking: "high", context: "200k" }, true)).toEqual({
      name: "Opus 4.8",
      detail: "Anthropic · 200K · Thinking High",
    });
  });

  it("names a provider's model by its provider, leaving out what does not apply", () => {
    expect(selectionSummary({ label: "Kimi K3", provider: "OpenCode Zen", thinking: "max", context: null }, false).detail).toBe(
      "OpenCode Zen · Thinking Max",
    );
    expect(selectionSummary({ label: "mystery", provider: null, thinking: null, context: null }, false).detail).toBe("");
  });
});
