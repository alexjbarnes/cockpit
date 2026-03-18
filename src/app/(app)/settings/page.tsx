"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { usePageHeader } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSettings, type DiffStyle, type ThinkingLevel } from "@/hooks/use-settings";
import { ChevronRight, RefreshCw, Download } from "lucide-react";

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

const modelOptions: { value: string; label: string }[] = [
  { value: "opus", label: "Opus" },
  { value: "opus[1m]", label: "Opus (1M)" },
  { value: "sonnet", label: "Sonnet" },
  { value: "sonnet[1m]", label: "Sonnet (1M)" },
  { value: "haiku", label: "Haiku" },
];

const thinkingOptions: { value: ThinkingLevel; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
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

function Toggle({ enabled, color, onToggle }: { enabled: boolean; color?: string; onToggle: () => void }) {
  const bg = enabled ? (color || "bg-green-500") : "bg-muted-foreground/30";
  return (
    <button onClick={onToggle} className="shrink-0">
      <span className={`inline-flex h-7 w-12 items-center rounded-full transition-colors ${bg}`}>
        <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`} />
      </span>
    </button>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-2 py-2 text-sm">
      <span>{label}</span>
      {children}
    </div>
  );
}

function NavRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center justify-between rounded px-2 py-2.5 text-sm hover:bg-muted transition-colors"
    >
      <span>{label}</span>
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </button>
  );
}

function ButtonGroup<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1">
      {options.map((opt) => (
        <Button
          key={opt.value}
          variant={value === opt.value ? "default" : "outline"}
          size="sm"
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}

interface VersionInfo {
  installed: string;
  latest: string;
  updateCommand: string;
}

export default function SettingsPage() {
  const { settings, updateSetting } = useSettings();
  const [theme, setTheme] = useState<Theme>("system");
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [versionLoading, setVersionLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<{ ok: boolean; message: string } | null>(null);
  const router = useRouter();

  usePageHeader("Settings", true);

  const fetchVersion = useCallback(() => {
    setVersionLoading(true);
    fetch("/api/version")
      .then((res) => res.json())
      .then((data: VersionInfo) => setVersion(data))
      .catch(() => setVersion(null))
      .finally(() => setVersionLoading(false));
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem("aperture-theme") as Theme | null;
    setTheme(stored || "system");
  }, []);

  useEffect(() => {
    fetchVersion();
  }, [fetchVersion]);

  const triggerUpdate = useCallback(async () => {
    setUpdating(true);
    setUpdateResult(null);
    try {
      const res = await fetch("/api/version", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setUpdateResult({ ok: true, message: "Updated successfully" });
        fetchVersion();
      } else {
        setUpdateResult({ ok: false, message: data.error || "Update failed" });
      }
    } catch {
      setUpdateResult({ ok: false, message: "Update failed" });
    } finally {
      setUpdating(false);
    }
  }, [fetchVersion]);

  const selectTheme = useCallback((t: Theme) => {
    setTheme(t);
    localStorage.setItem("aperture-theme", t);
    applyTheme(t);
  }, []);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Claude Code</CardTitle>
            <button
              onClick={fetchVersion}
              disabled={versionLoading}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className={`h-4 w-4 ${versionLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between px-2">
              <span className="text-muted-foreground">Installed</span>
              <span className="font-mono">{version?.installed || "..."}</span>
            </div>
            <div className="flex items-center justify-between px-2">
              <span className="text-muted-foreground">Latest</span>
              <span className="font-mono">{version?.latest || "..."}</span>
            </div>
            {version && version.installed !== "unknown" && version.latest !== "unknown" && version.installed !== version.latest && (
              <div className="space-y-2 px-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-amber-500">Update available</p>
                  <Button size="sm" variant="outline" onClick={triggerUpdate} disabled={updating}>
                    <Download className="h-3.5 w-3.5 mr-1" />
                    {updating ? "Updating..." : "Update"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground font-mono break-all">{version.updateCommand}</p>
              </div>
            )}
            {version && version.installed !== "unknown" && version.latest !== "unknown" && version.installed === version.latest && (
              <p className="text-xs text-green-500 px-2">Up to date</p>
            )}
            {updateResult && (
              <p className={`text-xs px-2 ${updateResult.ok ? "text-green-500" : "text-destructive"}`}>{updateResult.message}</p>
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Session defaults</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <SettingRow label="Model">
            <ButtonGroup options={modelOptions} value={settings.model} onChange={(v) => updateSetting("model", v)} />
          </SettingRow>
          <SettingRow label="Thinking level">
            <ButtonGroup options={thinkingOptions} value={settings.thinkingLevel} onChange={(v) => updateSetting("thinkingLevel", v)} />
          </SettingRow>
          <SettingRow label="Bypass all permissions">
            <Toggle enabled={settings.bypassAllPermissions} color="bg-orange-500" onToggle={() => updateSetting("bypassAllPermissions", !settings.bypassAllPermissions)} />
          </SettingRow>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Display</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <SettingRow label="Theme">
            <ButtonGroup options={themeOptions} value={theme} onChange={selectTheme} />
          </SettingRow>
          <SettingRow label="Diff style">
            <ButtonGroup options={diffOptions} value={settings.diffStyle} onChange={(v) => updateSetting("diffStyle", v)} />
          </SettingRow>
          <SettingRow label="Thinking blocks">
            <ButtonGroup
              options={[{ value: "collapsed" as const, label: "Collapsed" }, { value: "expanded" as const, label: "Expanded" }]}
              value={settings.thinkingExpanded ? "expanded" : "collapsed"}
              onChange={(v) => updateSetting("thinkingExpanded", v === "expanded")}
            />
          </SettingRow>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Input</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingRow label="Dismiss keyboard on send">
            <Toggle enabled={settings.dismissKeyboardOnSend} onToggle={() => updateSetting("dismissKeyboardOnSend", !settings.dismissKeyboardOnSend)} />
          </SettingRow>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Customization</CardTitle>
        </CardHeader>
        <CardContent className="space-y-0.5">
          <NavRow label="Agents" onClick={() => router.push("/agents")} />
          <NavRow label="MCP Servers" onClick={() => router.push("/mcp-servers")} />
          <NavRow label="Skills" onClick={() => router.push("/skills")} />
          <NavRow label="Commands" onClick={() => router.push("/commands")} />
          <NavRow label="Hooks" onClick={() => router.push("/hooks")} />
          <NavRow label="CLAUDE.md" onClick={() => router.push("/claude-md")} />
        </CardContent>
      </Card>
    </div>
  );
}
