import type { ProviderModel, ThinkingLevel } from "@/types";

export const CONTEXT_SIZES = {
  "200k": { label: "200K", disableEnv: true, window: 200_000 },
  "1m": { label: "1M", disableEnv: false, window: 1_000_000 },
} as const;

export type ContextSize = keyof typeof CONTEXT_SIZES;

export const DEFAULT_CONTEXT_SIZE: ContextSize = "200k";

export function contextSizeToWindow(size: ContextSize): number {
  return CONTEXT_SIZES[size].window;
}

export type ModelAlias = "opus" | "sonnet" | "haiku";

export interface ModelEntry {
  alias: ModelAlias;
  version: string;
  modelId: string;
  displayName: string;
  description: string;
  contextSizes: ContextSize[];
  contextWindow?: number;
  isDefault?: boolean;
  supportsXhigh?: boolean;
}

export const MODELS: ModelEntry[] = [
  {
    alias: "haiku",
    version: "4.5",
    modelId: "claude-haiku-4-5-20251001",
    displayName: "Haiku 4.5",
    description: "Fastest",
    contextSizes: ["200k"],
    contextWindow: 200_000,
    isDefault: true,
  },
  {
    alias: "sonnet",
    version: "4.6",
    modelId: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description: "Balanced",
    contextSizes: ["200k", "1m"],
    contextWindow: 200_000,
    isDefault: true,
  },
  {
    alias: "opus",
    version: "4.6",
    modelId: "claude-opus-4-6",
    displayName: "Opus 4.6",
    description: "Previous generation",
    contextSizes: ["200k", "1m"],
    contextWindow: 200_000,
  },
  {
    alias: "opus",
    version: "4.7",
    modelId: "claude-opus-4-7",
    displayName: "Opus 4.7",
    description: "Previous generation",
    contextSizes: ["200k", "1m"],
    contextWindow: 200_000,
    supportsXhigh: true,
  },
  {
    alias: "opus",
    version: "4.8",
    modelId: "claude-opus-4-8",
    displayName: "Opus 4.8",
    description: "Most capable",
    contextSizes: ["200k", "1m"],
    contextWindow: 200_000,
    isDefault: true,
    supportsXhigh: true,
  },
];

export function findModelById(modelId: string | undefined | null): ModelEntry | undefined {
  if (!modelId) return undefined;
  return MODELS.find((m) => m.modelId === modelId);
}

export function versionsForAlias(alias: ModelAlias): ModelEntry[] {
  return MODELS.filter((m) => m.alias === alias);
}

export function defaultForAlias(alias: ModelAlias): ModelEntry | undefined {
  return MODELS.find((m) => m.alias === alias && m.isDefault) ?? versionsForAlias(alias)[0];
}

export function resolveModel(model: string | undefined | null): ModelEntry | null {
  if (!model) return null;
  const base = model.replace(/\[.*\]$/, "");
  if (base === "opus" || base === "sonnet" || base === "haiku") {
    return defaultForAlias(base) ?? null;
  }
  return findModelById(base) ?? null;
}

export function allowedEffortLevels(entry: ModelEntry | null | undefined): ThinkingLevel[] {
  if (!entry || entry.alias === "haiku") return [];
  const levels: ThinkingLevel[] = ["low", "medium", "high"];
  if (entry.supportsXhigh) levels.push("xhigh");
  levels.push("max");
  return levels;
}

export function recommendedEffort(entry: ModelEntry | null | undefined): ThinkingLevel | null {
  if (!entry || entry.alias === "haiku") return null;
  if (entry.supportsXhigh) return "xhigh";
  if (entry.alias === "sonnet") return "medium";
  return "high";
}

export function coerceEffort(level: ThinkingLevel, entry: ModelEntry | null | undefined): ThinkingLevel | null {
  const allowed = allowedEffortLevels(entry);
  if (allowed.length === 0) return null;
  if (allowed.includes(level)) return level;
  return recommendedEffort(entry) ?? allowed[allowed.length - 1] ?? null;
}

export function toProviderModels(): ProviderModel[] {
  return MODELS.map((m) => ({
    modelId: m.modelId,
    displayName: m.displayName,
    effortLevels: allowedEffortLevels(m),
    contextSizes: m.contextSizes,
    defaultEffort: recommendedEffort(m) ?? undefined,
  }));
}

export function splitLegacyModel(stored: string | undefined | null): {
  model: string | undefined;
  contextSize: ContextSize;
} {
  if (!stored) return { model: undefined, contextSize: DEFAULT_CONTEXT_SIZE };
  const hasOneM = /\[1m\]$/i.test(stored);
  const stripped = stored.replace(/\[.*\]$/, "");
  return {
    model: stripped || undefined,
    contextSize: hasOneM ? "1m" : "200k",
  };
}

export function resolveProviderId(currentModel: string, providers: { id: string; models: { modelId: string }[] }[] | undefined): string {
  if (!providers) return "anthropic";
  const stripped = currentModel.replace(/\[.*\]$/, "");
  const provider = providers.find((p) => p.models.some((m) => m.modelId === stripped || `${p.id}:${m.modelId}` === stripped));
  return provider?.id ?? "anthropic";
}
