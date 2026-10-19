import {
  allowedEffortLevels,
  CONTEXT_SIZES,
  type ContextSize,
  defaultForAlias,
  findModelById,
  type ModelAlias,
  type ModelEntry,
  versionsForAlias,
} from "@/lib/models";
import type { Provider, ProviderModel, ThinkingLevel } from "@/types";

/**
 * The Model tab of the session settings: how the current model runs (its
 * version, context window and thinking), and the list a different model is
 * picked from. The decisions live here rather than in the component, which is
 * outside vitest's coverage and has no DOM to test against.
 */

export const MODEL_ALIASES: { value: ModelAlias; label: string }[] = [
  { value: "haiku", label: "Haiku" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "fable", label: "Fable" },
];

export const THINKING_LEVELS: { value: ThinkingLevel; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];

/** The provider filter's "everything" value. */
export const ALL_PROVIDERS = "all";
const ANTHROPIC = "anthropic";

export interface ParsedModel {
  alias: ModelAlias | null;
  entry: ModelEntry | null;
  contextSize: ContextSize;
}

/** The current model as the catalogue knows it: an alias resolves to its
 *  default version, a full id to its own entry, anything else to neither. */
export function parseCurrentModel(currentModel: string, currentContextSize: ContextSize): ParsedModel {
  const base = currentModel.replace(/\[.*\]$/, "");
  if (base === "opus" || base === "sonnet" || base === "haiku" || base === "fable") {
    return { alias: base, entry: defaultForAlias(base) ?? null, contextSize: currentContextSize };
  }
  const entry = findModelById(base) ?? null;
  return { alias: entry?.alias ?? null, entry, contextSize: currentContextSize };
}

/** The value stored for a catalogue entry: its alias when it is the alias's
 *  only version and the default, otherwise its full id. */
export function valueForEntry(entry: ModelEntry): string {
  const versions = versionsForAlias(entry.alias);
  const isSoleDefault = versions.length === 1 && entry.isDefault;
  return isSoleDefault ? entry.alias : entry.modelId;
}

/** The value stored when an alias is picked from the list: its default version. */
export function valueForAlias(alias: ModelAlias): string {
  const entry = defaultForAlias(alias);
  if (!entry) return alias;
  return valueForEntry(entry);
}

export interface ModelTuning {
  parsed: ParsedModel;
  /** The alias's versions; empty for a provider's model, which has none. */
  versions: ModelEntry[];
  /** The context sizes on offer. A 1M window that needs usage credits is
   *  only offered once they are opted into. */
  contextSizes: ContextSize[];
  /** The thinking levels on offer, "off" first whenever the model can think
   *  at all ("off" is not an --effort value, so it is never listed alone). */
  thinkingLevels: { value: ThinkingLevel; label: string }[];
}

/** What the "Thinking & context" view offers for the current model. */
export function modelTuning(
  currentModel: string,
  currentContextSize: ContextSize,
  providers: Provider[] | undefined,
  allowSonnet1m = false,
): ModelTuning {
  const parsed = parseCurrentModel(currentModel, currentContextSize);
  const versions = parsed.alias ? versionsForAlias(parsed.alias) : [];

  let served: ProviderModel | undefined;
  for (const p of currentModel ? (providers ?? []) : []) {
    served = p.models.find((pm) => currentModel === pm.modelId || currentModel === `${p.id}:${pm.modelId}`);
    if (served) break;
  }

  // A synced entry can predate a field: contextSizes and effortLevels are
  // guarded, or an old provider config takes the whole page down.
  const contextSizes = parsed.entry
    ? parsed.entry.oneMRequiresCredits && !allowSonnet1m
      ? parsed.entry.contextSizes.filter((s) => s !== "1m")
      : parsed.entry.contextSizes
    : (served?.contextSizes ?? []);

  const providerEffort = served?.effortLevels ?? [];
  const allowed = new Set(providerEffort.length > 0 ? providerEffort : allowedEffortLevels(parsed.entry));
  const thinkingLevels = THINKING_LEVELS.filter((opt) => (opt.value === "off" ? allowed.size > 0 : allowed.has(opt.value)));

  return { parsed, versions, contextSizes, thinkingLevels };
}

export interface PickerGroup {
  provider: Provider;
  models: ProviderModel[];
}

/** The providers whose models the list offers, each with the models it may
 *  offer. Anthropic's own models are the aliases, listed separately. */
export function pickerGroups(providers: Provider[] | undefined): PickerGroup[] {
  return (
    (providers ?? [])
      // Built-ins list only when connected: their model lists sync keylessly
      // for the settings preview, but a picker entry must be runnable.
      .filter((p) => p.id !== ANTHROPIC && (!p.isBuiltin || Object.keys(p.envVars).length > 0))
      .map((p) => ({
        provider: p,
        // Catalogue-backed built-ins show their curated enabled set only;
        // manual providers show everything they declare.
        models: p.isBuiltin && p.enabledModels ? p.models.filter((m) => (p.enabledModels ?? []).includes(m.modelId)) : p.models,
      }))
      .filter((g) => g.models.length > 0)
  );
}

/** A search matches a model's id or its display name. */
export function modelMatches(model: ProviderModel, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || model.modelId.toLowerCase().includes(q) || model.displayName.toLowerCase().includes(q);
}

export interface PickerList {
  /** Recent sits on top of everything while nothing narrows the list. */
  showRecent: boolean;
  aliases: { value: ModelAlias; label: string }[];
  groups: PickerGroup[];
}

/** What the list shows for a provider filter and a search. */
export function filterPicker(groups: PickerGroup[], providerFilter: string, query: string): PickerList {
  const all = providerFilter === ALL_PROVIDERS;
  const q = query.trim().toLowerCase();
  return {
    showRecent: all && !q,
    aliases:
      all || providerFilter === ANTHROPIC
        ? MODEL_ALIASES.filter((a) => !q || a.label.toLowerCase().includes(q) || a.value.includes(q))
        : [],
    groups: groups
      .filter((g) => all || g.provider.id === providerFilter)
      .map((g) => ({ provider: g.provider, models: g.models.filter((m) => modelMatches(m, q)) }))
      .filter((g) => g.models.length > 0),
  };
}

export interface ProviderOption {
  id: string;
  name: string;
  count: number;
}

/** The provider filter's choices, each with how many models it lists. */
export function providerOptions(groups: PickerGroup[]): ProviderOption[] {
  const aliasCount = MODEL_ALIASES.length;
  return [
    { id: ALL_PROVIDERS, name: "All providers", count: groups.reduce((n, g) => n + g.models.length, aliasCount) },
    { id: ANTHROPIC, name: "Anthropic", count: aliasCount },
    ...groups.map((g) => ({ id: g.provider.id, name: g.provider.name, count: g.models.length })),
  ];
}

/**
 * The line under the view switch, saying what is set so the other view never
 * has to be opened just to check: the model's name, then its provider, context
 * and thinking where each applies. A catalogue model has no provider of its
 * own in the selection, and is Anthropic's.
 */
export function selectionSummary(
  selection: { label: string; provider: string | null; thinking: ThinkingLevel | null; context: ContextSize | null },
  fromCatalogue: boolean,
): { name: string; detail: string } {
  const thinking = THINKING_LEVELS.find((t) => t.value === selection.thinking)?.label;
  const detail = [
    selection.provider ?? (fromCatalogue ? "Anthropic" : null),
    selection.context ? CONTEXT_SIZES[selection.context].label : null,
    thinking ? `Thinking ${thinking}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return { name: selection.label, detail };
}
