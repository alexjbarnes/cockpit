"use client";

import { type ReactNode, useMemo, useState } from "react";
import { ModelPickerList } from "@/components/model-picker-list";
import { ALL_PROVIDERS, type ModelTuning, modelTuning, selectionSummary, valueForEntry } from "@/lib/model-picker";
import { CONTEXT_SIZES, type ContextSize } from "@/lib/models";
import type { Provider, ThinkingLevel } from "@/types";

type View = "tune" | "model";

interface ModelSettingsProps {
  currentModel: string;
  currentContextSize: ContextSize;
  thinkingLevel: ThinkingLevel;
  providers?: Provider[];
  allowSonnet1m?: boolean;
  recentModels: string[];
  /** What the composer's pill shows, so the line here says the same thing. */
  selection: { label: string; provider: string | null; thinking: ThinkingLevel | null; context: ContextSize | null };
  /** Picking a model from the list, which also records it as recent. */
  onSelectModel: (value: string) => void;
  /** A version or context change on the model already selected. */
  onSetModel: (model: string, contextSize?: ContextSize) => void;
  onSetThinking: (level: ThinkingLevel) => void;
}

/**
 * The session settings' Model tab: two views behind a switch, each with the
 * whole card. "Thinking & context" comes first and is what opens, since it is
 * what changes most; "Model" is the list a different model is picked from. The
 * line under the switch always says what is set, so neither view has to be
 * opened just to check the other.
 */
export function ModelSettings(props: ModelSettingsProps) {
  const { currentModel, currentContextSize, providers, allowSonnet1m, selection } = props;
  const [view, setView] = useState<View>("tune");
  // Held here rather than in the list, so going to the other view and back
  // keeps the search where it was.
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState(ALL_PROVIDERS);

  const tuning = useMemo(
    () => modelTuning(currentModel, currentContextSize, providers, allowSonnet1m),
    [currentModel, currentContextSize, providers, allowSonnet1m],
  );
  const summary = selectionSummary(selection, tuning.parsed.entry !== null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-2 gap-0.5 rounded-lg bg-muted p-0.5">
        {(["tune", "model"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            aria-pressed={view === v}
            data-testid={`model-view-${v}`}
            className={`truncate rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
              view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {v === "tune" ? "Thinking & context" : "Model"}
          </button>
        ))}
      </div>
      <p className="mt-2 shrink-0 text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="model-summary">
        Now <span className="font-medium text-foreground">{summary.name}</span>
        {summary.detail ? ` · ${summary.detail}` : ""}
      </p>

      {view === "tune" ? (
        <TuneView tuning={tuning} {...props} />
      ) : (
        <div className="mt-3 flex min-h-0 flex-1 flex-col">
          <ModelPickerList
            currentModel={currentModel}
            providers={providers}
            recentModels={props.recentModels}
            onSelectModel={props.onSelectModel}
            tuning={tuning}
            query={query}
            onQuery={setQuery}
            providerFilter={providerFilter}
            onProviderFilter={setProviderFilter}
          />
        </div>
      )}
    </div>
  );
}

/** Grid columns for a row of n buttons: one line when the box is wide enough,
 *  otherwise even rows. Never wider than the box — the old Version row (Opus
 *  has five) never wrapped, and scrolled the whole tab sideways on a phone. */
const SEGMENT_COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-2 @min-[200px]:grid-cols-4",
  5: "grid-cols-3 @min-[240px]:grid-cols-5",
  6: "grid-cols-3 @min-[320px]:grid-cols-6",
};

function Segmented<T extends string>({
  options,
  value,
  onSelect,
  testId,
}: {
  options: { value: T; label: string }[];
  value: T | undefined;
  onSelect: (value: T) => void;
  testId: (value: T) => string;
}) {
  return (
    <div className={`grid gap-1 ${SEGMENT_COLUMNS[options.length] ?? "grid-cols-3"}`}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onSelect(opt.value)}
          data-testid={testId(opt.value)}
          aria-pressed={opt.value === value}
          className={`truncate rounded-md px-1 py-1.5 text-xs transition-colors ${
            opt.value === value ? "bg-primary font-medium text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** One setting: its name and current value above, its control below. */
function Knob({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
  return (
    <div className="@container">
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        {value && <span className="font-medium text-foreground">{value}</span>}
      </div>
      {children}
    </div>
  );
}

function TuneView({ tuning, currentModel, thinkingLevel, onSetModel, onSetThinking }: ModelSettingsProps & { tuning: ModelTuning }) {
  const { parsed, versions, contextSizes, thinkingLevels } = tuning;
  // One size on offer is that size, whatever the session last asked for.
  const shownSize = contextSizes.length === 1 ? contextSizes[0] : parsed.contextSize;
  const thinkingLabel = thinkingLevels.find((t) => t.value === thinkingLevel)?.label;

  return (
    <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto" data-testid="model-tune">
      {versions.length > 0 && (
        <Knob label="Version" value={parsed.entry?.version}>
          <Segmented
            options={versions.map((entry) => ({ value: entry.modelId, label: entry.version }))}
            value={parsed.entry?.modelId}
            onSelect={(modelId) => {
              const entry = versions.find((v) => v.modelId === modelId);
              if (entry) onSetModel(valueForEntry(entry));
            }}
            testId={(modelId) => `version-${modelId}`}
          />
        </Knob>
      )}

      <Knob label="Context" value={contextSizes.length > 0 ? CONTEXT_SIZES[shownSize].label : undefined}>
        {contextSizes.length > 1 ? (
          <Segmented
            options={contextSizes.map((size) => ({ value: size, label: CONTEXT_SIZES[size].label }))}
            value={parsed.contextSize}
            onSelect={(size) => onSetModel(currentModel, size)}
            testId={(size) => `context-${size}`}
          />
        ) : (
          // Said rather than left out, so the panel does not jump when the
          // model changes.
          <p className="text-xs text-muted-foreground">
            {contextSizes.length === 1 ? "The only size this model offers." : "Set by the provider."}
          </p>
        )}
      </Knob>

      <Knob label="Thinking" value={thinkingLabel}>
        {thinkingLevels.length > 0 ? (
          <Segmented options={thinkingLevels} value={thinkingLevel} onSelect={onSetThinking} testId={(level) => `thinking-${level}`} />
        ) : (
          <p className="text-xs text-muted-foreground">This model has no thinking levels.</p>
        )}
      </Knob>
    </div>
  );
}
