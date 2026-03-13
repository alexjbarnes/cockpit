"use client";

import { Check } from "lucide-react";

const MODELS = [
  { id: "opus", label: "Claude Opus 4.6", description: "Most capable" },
  { id: "sonnet", label: "Claude Sonnet 4.6", description: "Balanced" },
  { id: "haiku", label: "Claude Haiku 4.5", description: "Fastest" },
];

interface ModelPickerProps {
  currentModel: string;
  onSelect: (model: string) => void;
}

export function ModelPicker({ currentModel, onSelect }: ModelPickerProps) {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="rounded-lg border border-border bg-card p-4 space-y-1">
        <div className="text-sm font-medium pb-2">Switch model</div>
        {MODELS.map((model) => {
          const active = currentModel === model.id;
          return (
            <button
              key={model.id}
              onClick={() => onSelect(model.id)}
              className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                active
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-muted text-foreground"
              }`}
            >
              <div className="w-4 shrink-0">
                {active && <Check className="h-4 w-4" />}
              </div>
              <span className="font-mono font-bold">{model.id}</span>
              <span className="text-muted-foreground">{model.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
