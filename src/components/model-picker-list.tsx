"use client";

import { Check, ChevronDown, Search, X } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { FreeBadge, splitProviderModelId } from "@/components/openrouter-provider";
import {
  ALL_PROVIDERS,
  filterPicker,
  type ModelTuning,
  type ProviderOption,
  pickerGroups,
  providerOptions,
  valueForAlias,
} from "@/lib/model-picker";
import type { Provider, ProviderModel } from "@/types";

interface ModelPickerListProps {
  currentModel: string;
  providers?: Provider[];
  recentModels: string[];
  onSelectModel: (value: string) => void;
  /** What the selected model offers, to mark its alias in the list. */
  tuning: ModelTuning;
  query: string;
  onQuery: (q: string) => void;
  providerFilter: string;
  onProviderFilter: (id: string) => void;
}

/** The provider filter: a menu rather than a native select so each choice can
 *  carry how many models it lists. */
function ProviderMenu({ options, value, onChange }: { options: ProviderOption[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.id === value) ?? options[0];

  return (
    <div ref={ref} className="relative min-w-0 max-w-[48%] shrink">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="model-provider"
        className="flex h-full max-w-full items-center gap-1.5 rounded border border-input bg-background px-2.5 py-1.5 text-xs hover:bg-muted"
      >
        <span className="truncate">{current.name}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-10 mt-1 max-h-72 w-60 max-w-[calc(100vw-4rem)] overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
          data-testid="model-provider-menu"
        >
          {options.map((o, i) => (
            <Fragment key={o.id}>
              {i === 1 && <div className="my-1 h-px bg-border" />}
              <button
                type="button"
                onClick={() => {
                  onChange(o.id);
                  setOpen(false);
                }}
                data-testid={`model-provider-${o.id}`}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
              >
                <Check className={`h-3.5 w-3.5 shrink-0 ${o.id === value ? "" : "invisible"}`} />
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                <span className="tabular-nums text-muted-foreground">{o.count}</span>
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/** Search and a provider filter over every model a pick can run: the Anthropic
 *  aliases first, then each connected provider's catalogue. The session
 *  settings' Model tab and the Session Defaults page both pick from this. */
export function ModelPickerList({
  currentModel,
  providers,
  recentModels,
  onSelectModel,
  tuning,
  query,
  onQuery,
  providerFilter,
  onProviderFilter,
}: ModelPickerListProps) {
  const groups = useMemo(() => pickerGroups(providers), [providers]);
  const options = useMemo(() => providerOptions(groups), [groups]);
  const list = filterPicker(groups, providerFilter, query);
  const filterName = options.find((o) => o.id === providerFilter)?.name;

  const row = (key: string, selected: boolean, onClick: () => void, label: ReactNode) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-3 rounded px-3 py-2 text-left text-xs transition-colors ${
        selected ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted"
      }`}
    >
      <div className="mt-0.5 w-3 shrink-0">
        {selected ? <Check className="h-3 w-3" /> : <div className="h-3 w-3 rounded-full border border-muted-foreground/40" />}
      </div>
      {label}
    </button>
  );

  // providerName is passed for rows outside a provider's group. The same model
  // can be served by several providers (Anthropic direct, OpenRouter, Zen), so
  // a bare name in Recent gives no clue which one a pick would use.
  const modelLabel = (model: ProviderModel, providerName?: string) => {
    const { name, meta } = splitProviderModelId(model);
    const metaLine = [providerName, meta].filter(Boolean).join(" · ");
    return (
      <span className="flex min-w-0 flex-col items-start gap-0.5">
        <span className="flex min-w-0 max-w-full items-start gap-2">
          <span className="min-w-0 break-all font-mono font-medium">{name}</span>
          {model.free && (
            <span className="shrink-0">
              <FreeBadge model={model} />
            </span>
          )}
        </span>
        {metaLine && <span className="max-w-full text-[10px] text-muted-foreground">{metaLine}</span>}
      </span>
    );
  };

  const groupLabel = (text: string, count?: number) => (
    <p className="flex justify-between gap-2 px-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      <span>{text}</span>
      {count !== undefined && <span>{count}</span>}
    </p>
  );

  const nothing = (!list.showRecent || recentModels.length === 0) && list.aliases.length === 0 && list.groups.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="model-picker">
      <div className="flex shrink-0 gap-2">
        <ProviderMenu options={options} value={providerFilter} onChange={onProviderFilter} />
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            data-testid="model-search"
            placeholder="Search models"
            aria-label="Search models"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            className="w-full rounded border border-input bg-background py-1.5 pl-7 pr-7 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {query && (
            <button
              type="button"
              onClick={() => onQuery("")}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden pr-1" data-testid="model-list">
        {list.showRecent && recentModels.length > 0 && (
          <>
            {groupLabel("Recent")}
            {recentModels.map((value) => {
              const colon = value.indexOf(":");
              const recentProvider = colon > 0 ? providers?.find((p) => p.id === value.slice(0, colon)) : undefined;
              const bare = (colon > 0 ? value.slice(colon + 1) : value).replace(/\[.*\]$/, "");
              const recentModel = recentProvider?.models.find((m) => m.modelId === bare);
              const selected = currentModel === value || currentModel === bare;
              // Same renderer as the provider groups; a recent whose model left
              // the catalogue falls back to its name and provider.
              const label = recentModel ? (
                modelLabel(recentModel, recentProvider?.name)
              ) : (
                <span className="flex min-w-0 flex-col items-start gap-0.5">
                  <span className="min-w-0 break-all font-mono font-medium">{bare.replace(/^[^/]+\//, "").replace(/:free$/, "")}</span>
                  <span className="max-w-full text-[10px] text-muted-foreground">
                    {recentProvider?.name ?? (colon > 0 ? value.slice(0, colon) : "Anthropic")}
                  </span>
                </span>
              );
              return row(`recent-${value}`, selected, () => onSelectModel(value), label);
            })}
          </>
        )}

        {list.aliases.length > 0 && (
          <>
            {groupLabel("Anthropic", list.aliases.length)}
            {list.aliases.map((opt) =>
              row(
                opt.value,
                tuning.parsed.alias === opt.value,
                () => onSelectModel(valueForAlias(opt.value)),
                <span className="font-mono font-medium">{opt.label}</span>,
              ),
            )}
          </>
        )}

        {list.groups.map(({ provider, models }) => (
          <div key={provider.id}>
            {groupLabel(provider.name, models.length)}
            {models.map((model) => {
              const qualified = `${provider.id}:${model.modelId}`;
              const selected = currentModel === qualified || currentModel === model.modelId;
              return row(qualified, selected, () => onSelectModel(qualified), modelLabel(model));
            })}
          </div>
        ))}

        {nothing && (
          <p className="px-1 py-3 text-xs text-muted-foreground">
            {providerFilter === ALL_PROVIDERS ? (
              "No models match."
            ) : (
              <>
                Nothing in {filterName} matches.{" "}
                <button
                  type="button"
                  onClick={() => onProviderFilter(ALL_PROVIDERS)}
                  className="text-foreground underline underline-offset-2"
                >
                  Search all providers
                </button>
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
