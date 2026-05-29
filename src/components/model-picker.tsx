"use client";

import { Check } from "lucide-react";
import { CONTEXT_SIZES, type ContextSize } from "@/lib/models";
import type { Provider } from "@/types";

interface ModelPickerProps {
  currentModel: string;
  currentContextSize?: ContextSize;
  activeModelId?: string | null;
  onSelect: (model: string, contextSize?: ContextSize) => void;
  providers: Provider[];
  slot?: "main" | "subagent" | "fast";
}

interface PickerRow {
  key: string;
  value: string;
  label: string;
  description: string;
  providerId: string;
  providerName: string;
  sizes: ContextSize[];
}

function buildRows(providers: Provider[]): PickerRow[] {
  const rows: PickerRow[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      const desc = model.effortLevels.length > 0 ? `Thinking: ${model.effortLevels.join(", ")}` : "No thinking";
      rows.push({
        key: `${provider.id}::${model.modelId}`,
        value: model.modelId,
        label: model.displayName,
        description: desc,
        providerId: provider.id,
        providerName: provider.name,
        sizes: model.contextSizes,
      });
    }
  }
  return rows;
}

export function ModelPicker({ currentModel, currentContextSize, onSelect, providers, slot }: ModelPickerProps) {
  const rows = buildRows(providers);

  let lastProvider = "";

  return (
    <div className="mx-auto max-w-3xl">
      <div className="rounded-lg border border-border bg-card p-4 space-y-1">
        <div className="flex items-baseline justify-between pb-2">
          <div className="text-sm font-medium">{slot ? `Switch ${slot} model` : "Switch model"}</div>
          <div className="text-xs text-muted-foreground font-mono">Current: {currentModel}</div>
        </div>
        {rows.map((row) => {
          const showHeader = row.providerName !== lastProvider;
          lastProvider = row.providerName;
          const active = row.value === currentModel;
          return (
            <div key={row.key}>
              {showHeader && (
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider pt-3 pb-1 px-3">{row.providerName}</div>
              )}
              <button
                onClick={() => onSelect(row.value)}
                className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  active ? "bg-primary/10 text-primary" : "hover:bg-muted text-foreground"
                }`}
              >
                <div className="w-4 shrink-0">{active && <Check className="h-4 w-4" />}</div>
                <span className="font-mono font-bold">{row.value}</span>
                <span className="text-muted-foreground">{row.label}</span>
                <span className="text-muted-foreground ml-auto text-xs">{row.description}</span>
              </button>
              {row.sizes.length >= 2 && (
                <div className="flex gap-1 pl-10 pt-1 pb-2">
                  {row.sizes.map((s) => (
                    <button
                      key={s}
                      onClick={() => onSelect(row.value, s)}
                      className={`rounded px-2 py-0.5 text-xs transition-colors ${
                        row.value === currentModel && currentContextSize === s
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {CONTEXT_SIZES[s].label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
