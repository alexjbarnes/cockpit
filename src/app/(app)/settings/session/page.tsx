"use client";

import { ArrowLeft, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { ModelPickerList } from "@/components/model-picker-list";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { type ThinkingLevel, useSettings } from "@/hooks/use-settings";
import { ALL_PROVIDERS, defaultSelectionFor, modelTuning, valueForEntry } from "@/lib/model-picker";
import { CONTEXT_SIZES, type ContextSize, describeModelSelection } from "@/lib/models";
import type { Provider, SandboxSupport, SessionPermissionMode } from "@/types";

// Bypass keeps the orange the session panel uses for it, as a warning.
const permissionOptions: { value: SessionPermissionMode; label: string; activeClassName?: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "auto", label: "Auto" },
  { value: "bypass", label: "Bypass", activeClassName: "bg-orange-500 text-white hover:bg-orange-500/90" },
];

function Toggle({ enabled, color, disabled, onToggle }: { enabled: boolean; color?: string; disabled?: boolean; onToggle: () => void }) {
  const bg = enabled ? color || "bg-green-500" : "bg-muted-foreground/30";
  return (
    <button onClick={onToggle} disabled={disabled} className="shrink-0 disabled:opacity-60">
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
    <div className="flex items-start justify-between gap-3 py-2.5 text-sm">
      <span className="shrink-0 py-1">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ButtonGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; activeClassName?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 justify-end">
      {options.map((opt) => (
        <Button
          key={opt.value}
          variant={value === opt.value ? "default" : "outline"}
          size="sm"
          className={value === opt.value ? opt.activeClassName : undefined}
          onClick={() => onChange(opt.value)}
        >
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
  // Gate the sandbox toggle on whether this host can enforce one, as the
  // session panel does, rather than offer a default that would do nothing.
  const [sandboxSupport, setSandboxSupport] = useState<SandboxSupport | null>(null);
  useEffect(() => {
    fetch("/api/sandbox/support")
      .then((res) => res.json())
      .then((data: SandboxSupport) => setSandboxSupport(data))
      .catch(() =>
        setSandboxSupport({ supported: false, networkIsolation: false, platform: "", reason: "Could not check sandbox support" }),
      );
  }, []);

  // Every model a session can run: the Anthropic aliases and each connected
  // provider's catalogue, the same list the session panel picks from.
  const [providers, setProviders] = useState<Provider[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState(ALL_PROVIDERS);
  useEffect(() => {
    fetch("/api/providers")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setProviders(data);
      })
      .catch(() => {});
  }, []);

  const mainModel = settings.modelSlots?.main ?? "sonnet";
  const mainContext: ContextSize = settings.modelSlots?.mainContext ?? "200k";
  const tuning = modelTuning(mainModel, mainContext, providers, settings.allowSonnet1m);
  const selection = describeModelSelection(mainModel, settings.thinkingLevel, mainContext, providers);
  const contextSizes = tuning.contextSizes;
  const shownContext = contextSizes.includes(mainContext) ? mainContext : (contextSizes[0] ?? "200k");
  const versions = tuning.versions;

  function pickModel(value: string) {
    const next = defaultSelectionFor(
      value,
      { contextSize: mainContext, thinkingLevel: settings.thinkingLevel },
      providers,
      settings.allowSonnet1m,
    );
    updateSetting("modelSlots", { ...settings.modelSlots, main: next.model, mainContext: next.contextSize });
    if (next.thinkingLevel !== settings.thinkingLevel) updateSetting("thinkingLevel", next.thinkingLevel);
    setPickerOpen(false);
  }

  function selectVersion(modelId: string) {
    const ver = versions.find((m) => m.modelId === modelId);
    if (!ver) return;
    pickModel(valueForEntry(ver));
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
      <Button variant="ghost" size="sm" className="mb-4" onClick={() => router.push("/settings")}>
        <ArrowLeft className="h-4 w-4 mr-1" />
        Settings
      </Button>
      <div className="space-y-1">
        <SettingRow label="Model">
          <Button
            variant="outline"
            size="sm"
            data-testid="default-model-open"
            onClick={() => setPickerOpen(true)}
            className="max-w-72 justify-between gap-2 font-normal"
          >
            <span className="truncate">{selection.provider ? `${selection.provider} · ${selection.label}` : selection.label}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </SettingRow>
        {versions.length > 1 && (
          <SettingRow label="Version">
            <ButtonGroup
              options={versions.map((m) => ({ value: m.modelId, label: m.version }))}
              value={tuning.parsed.entry?.modelId ?? versions[0].modelId}
              onChange={selectVersion}
            />
          </SettingRow>
        )}
        {contextSizes.length >= 2 && (
          <SettingRow label="Context">
            <ButtonGroup
              options={contextSizes.map((s) => ({ value: s, label: CONTEXT_SIZES[s].label }))}
              value={shownContext}
              onChange={(v) => updateSetting("modelSlots", { ...settings.modelSlots, main: mainModel, mainContext: v })}
            />
          </SettingRow>
        )}
        {tuning.thinkingLevels.length > 0 ? (
          <SettingRow label="Thinking">
            <ButtonGroup
              options={tuning.thinkingLevels}
              value={settings.thinkingLevel}
              onChange={(v: ThinkingLevel) => updateSetting("thinkingLevel", v)}
            />
          </SettingRow>
        ) : (
          <SettingRow label="Thinking">
            <span className="text-xs text-muted-foreground">{selection.label} has no thinking levels.</span>
          </SettingRow>
        )}
        <SettingRow label="Permission mode">
          <ButtonGroup options={permissionOptions} value={settings.permissionMode} onChange={(v) => updateSetting("permissionMode", v)} />
        </SettingRow>
        {settings.permissionMode === "auto" && (
          <p className="-mt-1 pb-2 text-xs text-muted-foreground">Anthropic models only. A session on another provider starts in Manual.</p>
        )}
        <SettingRow label="Sandbox Bash">
          <Toggle
            enabled={settings.sandbox.enabled}
            color="bg-emerald-500"
            disabled={!sandboxSupport?.supported}
            onToggle={() => updateSetting("sandbox", { ...settings.sandbox, enabled: !settings.sandbox.enabled })}
          />
        </SettingRow>
        {!sandboxSupport?.supported ? (
          <p className="-mt-1 pb-2 text-xs text-muted-foreground">{sandboxSupport?.reason ?? "Checking sandbox support…"}</p>
        ) : settings.sandbox.enabled ? (
          <div className="-mt-1 space-y-1 pb-2">
            <span className="text-xs text-muted-foreground">Allowed network domains (one per line)</span>
            <textarea
              key={(settings.sandbox.allowedDomains ?? []).join("\n")}
              defaultValue={(settings.sandbox.allowedDomains ?? []).join("\n")}
              placeholder={"github.com\n*.npmjs.org"}
              onBlur={(e) =>
                updateSetting("sandbox", {
                  enabled: true,
                  allowedDomains: e.target.value
                    .split("\n")
                    .map((d) => d.trim())
                    .filter(Boolean),
                })
              }
              rows={3}
              className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              New sessions run Bash isolated, and its commands run without prompts even in Manual. These domains are added to the shared
              rules in{" "}
              <button type="button" className="underline underline-offset-2" onClick={() => router.push("/settings/sandbox")}>
                Sandbox settings
              </button>
              . Scheduled jobs have their own switch.
            </p>
          </div>
        ) : null}
        <SettingRow label="Alert me about other sessions">
          <Toggle enabled={settings.sessionAlerts} onToggle={() => updateSetting("sessionAlerts", !settings.sessionAlerts)} />
        </SettingRow>
        <p className="-mt-1 pb-2 text-xs text-muted-foreground">
          A banner at the top of the screen when a session that is not the one you are looking at finishes, asks a question, or waits for
          approval. A permission can be approved from the banner without leaving what you were doing.
        </p>
        <SettingRow label="Sonnet 4.6 1M context (needs usage credits)">
          <Toggle enabled={settings.allowSonnet1m} onToggle={() => updateSetting("allowSonnet1m", !settings.allowSonnet1m)} />
        </SettingRow>
      </div>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="flex h-[min(80vh,560px)] max-w-xl flex-col p-4">
          <DialogTitle className="mb-3 shrink-0 text-sm font-medium">Default model</DialogTitle>
          <ModelPickerList
            currentModel={mainModel}
            providers={providers}
            recentModels={[]}
            onSelectModel={pickModel}
            tuning={tuning}
            query={query}
            onQuery={setQuery}
            providerFilter={providerFilter}
            onProviderFilter={setProviderFilter}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
