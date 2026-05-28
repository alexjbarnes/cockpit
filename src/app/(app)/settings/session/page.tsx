"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { usePageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { type ThinkingLevel, useSettings } from "@/hooks/use-settings";
import { allowedEffortLevels, CONTEXT_SIZES, type ContextSize, defaultForAlias, type ModelAlias, recommendedEffort, resolveModel, versionsForAlias } from "@/lib/models";


const thinkingOptions: { value: ThinkingLevel; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];

function Toggle({ enabled, color, onToggle }: { enabled: boolean; color?: string; onToggle: () => void }) {
  const bg = enabled ? color || "bg-green-500" : "bg-muted-foreground/30";
  return (
    <button onClick={onToggle} className="shrink-0">
      <span className={`inline-flex h-7 w-12 items-center rounded-full transition-colors ${bg}`}>
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`}
        />
      </span>
    </button>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between py-2.5 text-sm">
      <span className="py-1">{label}</span>
      {children}
    </div>
  );
}

function ButtonGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 justify-end">
      {options.map((opt) => (
        <Button key={opt.value} variant={value === opt.value ? "default" : "outline"} size="sm" onClick={() => onChange(opt.value)}>
          {opt.label}
        </Button>
      ))}
    </div>
  );
}

export default function SessionSettingsPage() {
  usePageHeader("Session Defaults", { hideActions: true });
  const router = useRouter();
  const { settings, updateSetting } = useSettings();

  const mainModel = settings.modelSlots?.main ?? "sonnet";
  const mainContext: ContextSize = settings.modelSlots?.mainContext ?? "200k";
  const entry = resolveModel(mainModel);
  const selectedAlias = entry?.alias || "sonnet";
  const versions = versionsForAlias(selectedAlias);
  const showVersions = versions.length > 1;
  const effortLevels = allowedEffortLevels(entry);
  const visibleThinking = thinkingOptions.filter((opt) => effortLevels.includes(opt.value as ThinkingLevel));

  function selectAlias(alias: ModelAlias) {
    const def = defaultForAlias(alias);
    if (!def) return;
    updateSetting("modelSlots", {
      ...settings.modelSlots,
      main: def.modelId,
      mainContext: def.contextSizes.includes(mainContext) ? mainContext : (def.contextSizes[0] ?? "200k"),
    });
    const rec = recommendedEffort(def);
    if (rec) updateSetting("thinkingLevel", rec);
  }

  function selectVersion(version: string) {
    const ver = versions.find((m) => m.version === version);
    if (!ver) return;
    const nextSlots = {
      ...settings.modelSlots,
      main: ver.modelId,
      mainContext: ver.contextSizes.includes(mainContext) ? mainContext : (ver.contextSizes[0] ?? "200k"),
    };
    updateSetting("modelSlots", nextSlots);
    const levels = allowedEffortLevels(ver);
    if (!levels.includes(settings.thinkingLevel)) {
      const rec = recommendedEffort(ver);
      if (rec) updateSetting("thinkingLevel", rec);
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
      <Button variant="ghost" size="sm" className="mb-4" onClick={() => router.push("/settings")}>
        <ArrowLeft className="h-4 w-4 mr-1" />
        Settings
      </Button>
      <div className="max-w-lg space-y-1">
        <SettingRow label="Model">
          <ButtonGroup
            options={
              [
                { value: "haiku", label: "Haiku" },
                { value: "sonnet", label: "Sonnet" },
                { value: "opus", label: "Opus" },
              ] as { value: string; label: string }[]
            }
            value={selectedAlias}
            onChange={(v) => selectAlias(v as ModelAlias)}
          />
        </SettingRow>
        {showVersions && (
          <SettingRow label="Version">
            <ButtonGroup
              options={versions.map((m) => ({ value: m.version, label: m.version }))}
              value={entry?.version || versions[0].version}
              onChange={selectVersion}
            />
          </SettingRow>
        )}
        {entry && entry.contextSizes.length >= 2 && (
          <SettingRow label="Context">
            <ButtonGroup
              options={entry.contextSizes.map((s) => ({ value: s, label: CONTEXT_SIZES[s].label }))}
              value={mainContext}
              onChange={(v) =>
                updateSetting("modelSlots", {
                  ...settings.modelSlots,
                  main: entry.modelId,
                  mainContext: v,
                })
              }
            />
          </SettingRow>
        )}
        {visibleThinking.length > 0 && (
          <SettingRow label="Thinking">
            <ButtonGroup options={visibleThinking} value={settings.thinkingLevel} onChange={(v) => updateSetting("thinkingLevel", v)} />
          </SettingRow>
        )}
        <SettingRow label="Bypass all permissions">
          <Toggle
            enabled={settings.bypassAllPermissions}
            color="bg-orange-500"
            onToggle={() => updateSetting("bypassAllPermissions", !settings.bypassAllPermissions)}
          />
        </SettingRow>
      </div>
    </div>
  );
}
