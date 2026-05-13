import type { ProviderModel, ThinkingLevel } from "@/types";

export type ModelAlias = "opus" | "sonnet" | "haiku";

export interface ModelEntry {
  alias: ModelAlias;
  version: string;
  modelId: string;
  displayName: string;
  description: string;
  supportsExtendedContext: boolean;
  contextWindow?: number;
  isDefault?: boolean;
}

export const MODELS: ModelEntry[] = [
  {
    alias: "haiku",
    version: "4.5",
    modelId: "claude-haiku-4-5-20251001",
    displayName: "Haiku 4.5",
    description: "Fastest",
    supportsExtendedContext: false,
    contextWindow: 200_000,
    isDefault: true,
  },
  {
    alias: "sonnet",
    version: "4.6",
    modelId: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description: "Balanced",
    supportsExtendedContext: true,
    contextWindow: 200_000,
    isDefault: true,
  },
  {
    alias: "opus",
    version: "4.6",
    modelId: "claude-opus-4-6",
    displayName: "Opus 4.6",
    description: "Previous generation",
    supportsExtendedContext: true,
    contextWindow: 200_000,
  },
  {
    alias: "opus",
    version: "4.7",
    modelId: "claude-opus-4-7",
    displayName: "Opus 4.7",
    description: "Most capable",
    supportsExtendedContext: true,
    contextWindow: 200_000,
    isDefault: true,
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
  if (entry.alias === "opus" && entry.version === "4.7") levels.push("xhigh");
  levels.push("max");
  return levels;
}

export function recommendedEffort(entry: ModelEntry | null | undefined): ThinkingLevel | null {
  if (!entry || entry.alias === "haiku") return null;
  if (entry.alias === "opus" && entry.version === "4.7") return "xhigh";
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
    supportsExtendedContext: m.supportsExtendedContext,
    defaultEffort: recommendedEffort(m) ?? undefined,
  }));
}
