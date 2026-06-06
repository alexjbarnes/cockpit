"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";

interface AssistantSettings {
  model: string;
  thinkingLevel: string;
  runtime?: string;
  contextSize?: string;
}

const MODEL_OPTIONS = [
  { value: "haiku", label: "Haiku" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
];

const THINKING_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "X-High" },
  { value: "max", label: "Max" },
];

const RUNTIME_OPTIONS = [
  { value: "stream", label: "Stream" },
  { value: "pty", label: "PTY" },
];

const CONTEXT_OPTIONS = [
  { value: "200k", label: "200K" },
  { value: "1m", label: "1M" },
];

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

export default function AssistantSettingsPage() {
  usePageHeader("Cockpit Agent", { hideActions: true });
  const router = useRouter();
  const [settings, setSettings] = useState<AssistantSettings>({
    model: "sonnet",
    thinkingLevel: "high",
    runtime: "stream",
    contextSize: "200k",
  });
  const [_loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/assistant-settings")
      .then((r) => r.json())
      .then((data) => {
        setSettings(data);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const updateSetting = useCallback(
    async (partial: Partial<AssistantSettings>) => {
      const next = { ...settings, ...partial };
      setSettings(next);
      try {
        await fetch("/api/assistant-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(partial),
        });
      } catch {
        // best effort
      }
    },
    [settings],
  );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
      <Button variant="ghost" size="sm" className="mb-4" onClick={() => router.push("/settings")}>
        <ArrowLeft className="h-4 w-4 mr-1" />
        Settings
      </Button>
      <div className="max-w-lg space-y-1">
        <div className="flex items-start justify-between py-2.5 text-sm">
          <span className="py-1">Model</span>
          <ButtonGroup options={MODEL_OPTIONS} value={settings.model} onChange={(v) => updateSetting({ model: v })} />
        </div>
        <div className="flex items-start justify-between py-2.5 text-sm">
          <span className="py-1">Thinking level</span>
          <ButtonGroup options={THINKING_OPTIONS} value={settings.thinkingLevel} onChange={(v) => updateSetting({ thinkingLevel: v })} />
        </div>
        <div className="flex items-start justify-between py-2.5 text-sm">
          <span className="py-1">Runtime</span>
          <ButtonGroup options={RUNTIME_OPTIONS} value={settings.runtime ?? "stream"} onChange={(v) => updateSetting({ runtime: v })} />
        </div>
        <div className="flex items-start justify-between py-2.5 text-sm">
          <span className="py-1">Context size</span>
          <ButtonGroup
            options={CONTEXT_OPTIONS}
            value={settings.contextSize ?? "200k"}
            onChange={(v) => updateSetting({ contextSize: v })}
          />
        </div>
      </div>
    </div>
  );
}
