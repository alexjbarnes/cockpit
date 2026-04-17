"use client";

import { Check } from "lucide-react";
import { MODELS, findModelById, versionsForAlias, type ModelAlias, type ModelEntry } from "@/lib/models";

interface ModelPickerProps {
  currentModel: string;
  activeModelId: string | null;
  onSelect: (model: string) => void;
}

function baseAlias(model: string): string {
  return model.replace(/\[.*\]$/, "");
}

function hasExtendedContext(model: string): boolean {
  return model.includes("[1m]");
}

interface PickerRow {
  key: string;
  value: string;
  entry: ModelEntry;
  label: string;
  extended: boolean;
}

function rowsForEntry(entry: ModelEntry, isSoleVersion: boolean): PickerRow[] {
  const aliasForCli = isSoleVersion && entry.isDefault ? entry.alias : entry.modelId;
  const rows: PickerRow[] = [
    {
      key: `${entry.modelId}`,
      value: aliasForCli,
      entry,
      label: entry.displayName,
      extended: false,
    },
  ];
  if (entry.supportsExtendedContext) {
    rows.push({
      key: `${entry.modelId}[1m]`,
      value: isSoleVersion && entry.isDefault ? `${entry.alias}[1m]` : `${entry.modelId}[1m]`,
      entry,
      label: `${entry.displayName} (1M)`,
      extended: true,
    });
  }
  return rows;
}

function buildRows(): PickerRow[] {
  const aliases: ModelAlias[] = ["opus", "sonnet", "haiku"];
  const rows: PickerRow[] = [];
  for (const alias of aliases) {
    const entries = versionsForAlias(alias);
    const isSole = entries.length === 1;
    for (const entry of entries) {
      rows.push(...rowsForEntry(entry, isSole));
    }
  }
  return rows;
}

export function ModelPicker({ currentModel, activeModelId, onSelect }: ModelPickerProps) {
  const rows = buildRows();
  const activeEntry = findModelById(activeModelId);
  const currentBase = baseAlias(currentModel);
  const currentExtended = hasExtendedContext(currentModel);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="rounded-lg border border-border bg-card p-4 space-y-1">
        <div className="flex items-baseline justify-between pb-2">
          <div className="text-sm font-medium">Switch model</div>
          <div className="text-xs text-muted-foreground font-mono">
            {activeEntry
              ? `Current: ${activeEntry.displayName} (${activeEntry.modelId})`
              : activeModelId
                ? `Current: ${activeModelId}`
                : "Current: unknown"}
          </div>
        </div>
        {rows.map((row) => {
          const rowBase = baseAlias(row.value);
          const active =
            row.extended === currentExtended &&
            (rowBase === currentBase ||
              (activeEntry && row.entry.modelId === activeEntry.modelId && rowBase === currentBase));
          return (
            <button
              key={row.key}
              onClick={() => onSelect(row.value)}
              className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                active
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-muted text-foreground"
              }`}
            >
              <div className="w-4 shrink-0">
                {active && <Check className="h-4 w-4" />}
              </div>
              <span className="font-mono font-bold">{row.value}</span>
              <span className="text-muted-foreground">{row.label}</span>
              <span className="text-muted-foreground ml-auto text-xs">{row.entry.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
