"use client";

import { Check } from "lucide-react";
import type { Provider, ThinkingLevel } from "@/types";

interface ModelPickerProps {
  currentModel: string;
  activeModelId: string | null;
  onSelect: (model: string) => void;
  providers: Provider[];
  slot?: "main" | "subagent" | "fast";
}

function baseModel(model: string): string {
  return model.replace(/\[.*\]$/, "");
}

function hasExtendedContext(model: string): boolean {
  return model.includes("[1m]");
}

interface PickerRow {
  key: string;
  value: string;
  label: string;
  description: string;
  providerId: string;
  providerName: string;
  extended: boolean;
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
        extended: false,
      });
      if (model.supportsExtendedContext) {
        rows.push({
          key: `${provider.id}::${model.modelId}[1m]`,
          value: `${model.modelId}[1m]`,
          label: `${model.displayName} (1M)`,
          description: desc,
          providerId: provider.id,
          providerName: provider.name,
          extended: true,
        });
      }
    }
  }
  return rows;
}

export function ModelPicker({ currentModel, activeModelId, onSelect, providers, slot }: ModelPickerProps) {
  const rows = buildRows(providers);
  const currentBase = baseModel(currentModel);
  const currentExtended = hasExtendedContext(currentModel);

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
          const active = row.value === currentBase || (row.extended === currentExtended && baseModel(row.value) === currentBase);
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
