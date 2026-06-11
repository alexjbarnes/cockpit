"use client";

import { ArrowLeft, Info } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { type DiffStyle, useSettings } from "@/hooks/use-settings";

type Theme = "light" | "dark" | "system";

const diffOptions: { value: DiffStyle; label: string }[] = [
  { value: "split", label: "Side-by-side" },
  { value: "unified", label: "Inline" },
];

const themeOptions: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  const resolved = theme === "system" ? getSystemTheme() : theme;
  if (resolved === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  const bg = enabled ? "bg-green-500" : "bg-muted-foreground/30";
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

function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex">
      <button type="button" onClick={() => setOpen(!open)} className="p-0.5 rounded hover:bg-accent">
        <Info className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1.5 z-50 w-56 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
          {text}
        </div>
      )}
    </div>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between py-2.5 text-sm">
      <span className="py-1 flex items-center gap-1.5">
        {label}
        {hint && <InfoTip text={hint} />}
      </span>
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

export default function AppearanceSettingsPage() {
  usePageHeader("Appearance", { hideActions: true });
  const router = useRouter();
  const { settings, updateSetting } = useSettings();
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    const stored = localStorage.getItem("cockpit-theme") as Theme | null;
    setTheme(stored || "system");
  }, []);

  const selectTheme = useCallback((t: Theme) => {
    setTheme(t);
    localStorage.setItem("cockpit-theme", t);
    applyTheme(t);
  }, []);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
      <Button variant="ghost" size="sm" className="mb-4" onClick={() => router.push("/settings")}>
        <ArrowLeft className="h-4 w-4 mr-1" />
        Settings
      </Button>
      <div className="max-w-lg mx-auto space-y-1" data-testid="settings-content">
        <SettingRow label="Theme">
          <ButtonGroup options={themeOptions} value={theme} onChange={selectTheme} />
        </SettingRow>
        <SettingRow label="Diff style">
          <ButtonGroup options={diffOptions} value={settings.diffStyle} onChange={(v) => updateSetting("diffStyle", v)} />
        </SettingRow>
        <SettingRow label="Thinking blocks">
          <ButtonGroup
            options={[
              { value: "collapsed" as const, label: "Collapsed" },
              { value: "expanded" as const, label: "Expanded" },
            ]}
            value={settings.thinkingExpanded ? "expanded" : "collapsed"}
            onChange={(v) => updateSetting("thinkingExpanded", v === "expanded")}
          />
        </SettingRow>
        <SettingRow label="Read results">
          <ButtonGroup
            options={[
              { value: "collapsed" as const, label: "Collapsed" },
              { value: "expanded" as const, label: "Expanded" },
            ]}
            value={settings.readExpanded ? "expanded" : "collapsed"}
            onChange={(v) => updateSetting("readExpanded", v === "expanded")}
          />
        </SettingRow>
        <SettingRow label="Edit results">
          <ButtonGroup
            options={[
              { value: "collapsed" as const, label: "Collapsed" },
              { value: "expanded" as const, label: "Expanded" },
            ]}
            value={settings.editExpanded ? "expanded" : "collapsed"}
            onChange={(v) => updateSetting("editExpanded", v === "expanded")}
          />
        </SettingRow>
        <SettingRow label="Tool calls">
          <ButtonGroup
            options={[
              { value: "collapsed" as const, label: "Collapsed" },
              { value: "expanded" as const, label: "Expanded" },
            ]}
            value={settings.toolCallsExpanded ? "expanded" : "collapsed"}
            onChange={(v) => updateSetting("toolCallsExpanded", v === "expanded")}
          />
        </SettingRow>
        <SettingRow
          label="Stitch messages across clears"
          hint="Load messages from previous CLI sessions within the same Cockpit session, showing conversation history across /clear boundaries"
        >
          <Toggle enabled={settings.messageStitching} onToggle={() => updateSetting("messageStitching", !settings.messageStitching)} />
        </SettingRow>
        <SettingRow label="Dismiss keyboard on send">
          <Toggle
            enabled={settings.dismissKeyboardOnSend}
            onToggle={() => updateSetting("dismissKeyboardOnSend", !settings.dismissKeyboardOnSend)}
          />
        </SettingRow>
        <SettingRow label="Reviews" hint="Show the Reviews section in the sidebar for tracking PR reviews">
          <Toggle enabled={settings.reviewsEnabled} onToggle={() => updateSetting("reviewsEnabled", !settings.reviewsEnabled)} />
        </SettingRow>
      </div>
    </div>
  );
}
