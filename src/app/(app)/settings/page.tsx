"use client";

import { ChevronDown, ChevronRight, Download, ExternalLink, Info, Plus, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type DiffStyle, type ThinkingLevel, useSettings } from "@/hooks/use-settings";
import { allowedEffortLevels, defaultForAlias, type ModelAlias, recommendedEffort, resolveModel, versionsForAlias } from "@/lib/models";
import type { Provider } from "@/types";

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

function parseModelString(model: string): { base: string; extended: boolean } {
  const extended = model.includes("[1m]");
  const base = model.replace(/\[.*\]$/, "");
  return { base, extended };
}

function buildModelString(modelId: string, extended: boolean): string {
  if (extended) return `${modelId}[1m]`;
  return modelId;
}

const thinkingOptions: { value: ThinkingLevel; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
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
    <div className="flex items-start justify-between px-2 py-2 text-sm">
      <span className="py-1 flex items-center gap-1.5">
        {label}
        {hint && <InfoTip text={hint} />}
      </span>
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

interface VersionInfo {
  installed: string;
  latest: string;
  updateCommand: string;
}

interface CockpitVersionInfo {
  installed: string;
  latest: string;
  installMethod: "npm" | "npx" | "dev";
  updateCommand: string | null;
}

interface ChangelogRelease {
  version: string;
  date: string;
  sections: Array<{ heading: string; items: string[] }>;
}

interface ClaudeCodeRelease {
  version: string;
  items: string[];
}

function formatReleaseDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export default function SettingsPage() {
  const { settings, updateSetting, loaded: settingsLoaded } = useSettings();
  const [theme, setTheme] = useState<Theme>("system");
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [versionLoading, setVersionLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [cockpitVersion, setCockpitVersion] = useState<CockpitVersionInfo | null>(null);
  const [cockpitVersionLoading, setCockpitVersionLoading] = useState(true);
  const [cockpitUpdating, setCockpitUpdating] = useState(false);
  const [cockpitUpdateResult, setCockpitUpdateResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [changelogReleases, setChangelogReleases] = useState<ChangelogRelease[]>([]);
  const [changelogRepo, setChangelogRepo] = useState("");
  const [changelogExpanded, setChangelogExpanded] = useState(false);
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(new Set());
  const [ccReleases, setCcReleases] = useState<ClaudeCodeRelease[]>([]);
  const [ccChangelogExpanded, setCcChangelogExpanded] = useState(false);
  const [ccExpandedVersions, setCcExpandedVersions] = useState<Set<string>>(new Set());
  const [providers, setProviders] = useState<Provider[]>([]);
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);

  usePageHeader("Settings");

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const saved = sessionStorage.getItem("settings-scroll");
    if (saved) el.scrollTop = Number(saved);
    const onScroll = () => sessionStorage.setItem("settings-scroll", String(el.scrollTop));
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const fetchVersion = useCallback(() => {
    setVersionLoading(true);
    fetch("/api/version")
      .then((res) => res.json())
      .then((data: VersionInfo) => setVersion(data))
      .catch(() => setVersion(null))
      .finally(() => setVersionLoading(false));
  }, []);

  const fetchCockpitVersion = useCallback(() => {
    setCockpitVersionLoading(true);
    fetch("/api/version/cockpit")
      .then((res) => res.json())
      .then((data: CockpitVersionInfo) => setCockpitVersion(data))
      .catch(() => setCockpitVersion(null))
      .finally(() => setCockpitVersionLoading(false));
  }, []);

  const fetchProviders = useCallback(() => {
    fetch("/api/providers")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setProviders(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  useEffect(() => {
    const stored = localStorage.getItem("cockpit-theme") as Theme | null;
    setTheme(stored || "system");
  }, []);

  useEffect(() => {
    fetchVersion();
  }, [fetchVersion]);

  useEffect(() => {
    fetchCockpitVersion();
  }, [fetchCockpitVersion]);

  useEffect(() => {
    fetch("/api/version/cockpit/changelog")
      .then((res) => res.json())
      .then((data: { releases: ChangelogRelease[]; repo: string }) => {
        setChangelogReleases(data.releases || []);
        setChangelogRepo(data.repo || "");
      })
      .catch(() => {});
    fetch("/api/version/changelog")
      .then((res) => res.json())
      .then((data: { releases: ClaudeCodeRelease[] }) => setCcReleases(data.releases || []))
      .catch(() => {});
  }, []);

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

  const triggerCockpitUpdate = useCallback(async () => {
    setCockpitUpdating(true);
    setCockpitUpdateResult(null);
    try {
      const res = await fetch("/api/version/cockpit", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setCockpitUpdateResult({ ok: true, message: "Updated. Restart Cockpit to use the new version." });
        fetchCockpitVersion();
      } else {
        setCockpitUpdateResult({ ok: false, message: data.error || "Update failed" });
      }
    } catch {
      setCockpitUpdateResult({ ok: false, message: "Update failed" });
    } finally {
      setCockpitUpdating(false);
    }
  }, [fetchCockpitVersion]);

  const selectTheme = useCallback((t: Theme) => {
    setTheme(t);
    localStorage.setItem("cockpit-theme", t);
    applyTheme(t);
  }, []);

  return (
    <div
      ref={scrollRef}
      className={`flex-1 min-h-0 overflow-y-auto p-4 space-y-4 transition-opacity duration-150 ${settingsLoaded ? "opacity-100" : "opacity-0"}`}
    >
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
            {(() => {
              if (!version || version.installed === "unknown" || version.latest === "unknown") return null;
              const outdated = version.installed.localeCompare(version.latest, undefined, { numeric: true }) < 0;
              return outdated ? (
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
              ) : (
                <p className="text-xs text-green-500 px-2">Up to date</p>
              );
            })()}
            {updateResult && (
              <p className={`text-xs px-2 ${updateResult.ok ? "text-green-500" : "text-destructive"}`}>{updateResult.message}</p>
            )}
          </div>
          {ccReleases.length > 0 && (
            <>
              <div className="border-t mt-3 pt-3">
                <button
                  onClick={() => setCcChangelogExpanded(!ccChangelogExpanded)}
                  className="flex items-center justify-between w-full text-left px-2"
                >
                  <span className="text-sm font-medium">What's New</span>
                  <ChevronDown
                    className={`h-4 w-4 text-muted-foreground transition-transform ${ccChangelogExpanded ? "rotate-180" : ""}`}
                  />
                </button>
              </div>
              {ccChangelogExpanded && (
                <div className="mt-2 space-y-1">
                  {ccReleases.slice(0, 10).map((release) => {
                    const open = ccExpandedVersions.has(release.version);
                    return (
                      <div key={release.version}>
                        <button
                          onClick={() => {
                            setCcExpandedVersions((prev) => {
                              const next = new Set(prev);
                              if (next.has(release.version)) next.delete(release.version);
                              else next.add(release.version);
                              return next;
                            });
                          }}
                          className="flex items-center justify-between w-full text-left px-2 py-1.5 rounded hover:bg-muted transition-colors"
                        >
                          <span className="text-sm font-semibold">{release.version}</span>
                          <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
                        </button>
                        {open && (
                          <div className="px-2 pb-2">
                            <ul className="space-y-1.5 text-sm mt-1">
                              {release.items.map((item, i) => (
                                <li key={i} className="flex gap-2">
                                  <span className="text-muted-foreground mt-0.5 shrink-0">•</span>
                                  <span className="break-words min-w-0">{item}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div className="px-2 pt-2">
                    <a
                      href="https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                    >
                      Full changelog
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Cockpit</CardTitle>
            <button
              onClick={fetchCockpitVersion}
              disabled={cockpitVersionLoading}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className={`h-4 w-4 ${cockpitVersionLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between px-2">
              <span className="text-muted-foreground">Installed</span>
              <span className="font-mono">{cockpitVersion?.installed || "..."}</span>
            </div>
            <div className="flex items-center justify-between px-2">
              <span className="text-muted-foreground">Latest</span>
              <span className="font-mono">{cockpitVersion?.latest || "..."}</span>
            </div>
            {(() => {
              if (!cockpitVersion || cockpitVersion.installed === "unknown" || cockpitVersion.latest === "unknown") return null;
              const outdated = cockpitVersion.installed.localeCompare(cockpitVersion.latest, undefined, { numeric: true }) < 0;
              return outdated ? (
                <div className="space-y-2 px-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-amber-500">Update available</p>
                    {cockpitVersion.installMethod === "npm" && (
                      <Button size="sm" variant="outline" onClick={triggerCockpitUpdate} disabled={cockpitUpdating}>
                        <Download className="h-3.5 w-3.5 mr-1" />
                        {cockpitUpdating ? "Updating..." : "Update"}
                      </Button>
                    )}
                  </div>
                  {cockpitVersion.updateCommand && (
                    <p className="text-xs text-muted-foreground font-mono break-all">{cockpitVersion.updateCommand}</p>
                  )}
                  {cockpitVersion.installMethod === "npx" && (
                    <p className="text-xs text-muted-foreground">Restart to get the latest version</p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-green-500 px-2">Up to date</p>
              );
            })()}
            {cockpitUpdateResult && (
              <p className={`text-xs px-2 ${cockpitUpdateResult.ok ? "text-green-500" : "text-destructive"}`}>
                {cockpitUpdateResult.message}
              </p>
            )}
          </div>
          {changelogReleases.length > 0 && (
            <>
              <div className="border-t mt-3 pt-3">
                <button
                  onClick={() => setChangelogExpanded(!changelogExpanded)}
                  className="flex items-center justify-between w-full text-left px-2"
                >
                  <span className="text-sm font-medium">What's New</span>
                  <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${changelogExpanded ? "rotate-180" : ""}`} />
                </button>
              </div>
              {changelogExpanded && (
                <div className="mt-2 space-y-1">
                  {changelogReleases.slice(0, 10).map((release) => {
                    const open = expandedVersions.has(release.version);
                    return (
                      <div key={release.version}>
                        <button
                          onClick={() => {
                            setExpandedVersions((prev) => {
                              const next = new Set(prev);
                              if (next.has(release.version)) next.delete(release.version);
                              else next.add(release.version);
                              return next;
                            });
                          }}
                          className="flex items-center justify-between w-full text-left px-2 py-1.5 rounded hover:bg-muted transition-colors"
                        >
                          <div>
                            <span className="text-sm font-semibold">Version {release.version}</span>
                            <span className="text-xs text-muted-foreground ml-2">{formatReleaseDate(release.date)}</span>
                          </div>
                          <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
                        </button>
                        {open && (
                          <div className="px-2 pb-2">
                            {release.sections.map((section) => (
                              <div key={section.heading} className="mt-2">
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">{section.heading}</p>
                                <ul className="space-y-1.5 text-sm">
                                  {section.items.map((item, i) => (
                                    <li key={i} className="flex gap-2">
                                      <span className="text-muted-foreground mt-0.5 shrink-0">•</span>
                                      <span className="break-words min-w-0">{item.replace(/\*\*/g, "")}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {changelogRepo && (
                    <div className="px-2 pt-2">
                      <a
                        href={`https://github.com/${changelogRepo}/blob/main/CHANGELOG.md`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                      >
                        Full changelog
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Session defaults</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {(() => {
            const mainModel = settings.modelSlots?.main ?? "sonnet";
            const { base, extended } = parseModelString(mainModel);
            const entry = resolveModel(base);
            const selectedAlias = entry?.alias || "sonnet";
            const versions = versionsForAlias(selectedAlias);
            const showVersions = versions.length > 1;
            const effortLevels = allowedEffortLevels(entry);
            const visibleThinking = thinkingOptions.filter((opt) => effortLevels.includes(opt.value as ThinkingLevel));

            function selectAlias(alias: ModelAlias) {
              const def = defaultForAlias(alias);
              if (!def) return;
              updateSetting("modelSlots", { ...settings.modelSlots, main: def.modelId });
              const rec = recommendedEffort(def);
              if (rec) updateSetting("thinkingLevel", rec);
            }

            function selectVersion(version: string) {
              const ver = versions.find((m) => m.version === version);
              if (!ver) return;
              updateSetting("modelSlots", {
                ...settings.modelSlots,
                main: buildModelString(ver.modelId, extended && ver.supportsExtendedContext),
              });
              const levels = allowedEffortLevels(ver);
              if (!levels.includes(settings.thinkingLevel)) {
                const rec = recommendedEffort(ver);
                if (rec) updateSetting("thinkingLevel", rec);
              }
            }

            return (
              <>
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
                {entry?.supportsExtendedContext && (
                  <SettingRow label="Context">
                    <ButtonGroup
                      options={[
                        { value: "default", label: "200K" },
                        { value: "1m", label: "1M" },
                      ]}
                      value={extended ? "1m" : "default"}
                      onChange={(v) =>
                        updateSetting("modelSlots", { ...settings.modelSlots, main: buildModelString(entry.modelId, v === "1m") })
                      }
                    />
                  </SettingRow>
                )}
                {visibleThinking.length > 0 && (
                  <SettingRow label="Thinking">
                    <ButtonGroup
                      options={visibleThinking}
                      value={settings.thinkingLevel}
                      onChange={(v) => updateSetting("thinkingLevel", v)}
                    />
                  </SettingRow>
                )}
              </>
            );
          })()}
          <SettingRow label="Bypass all permissions">
            <Toggle
              enabled={settings.bypassAllPermissions}
              color="bg-orange-500"
              onToggle={() => updateSetting("bypassAllPermissions", !settings.bypassAllPermissions)}
            />
          </SettingRow>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Providers</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => router.push("/settings/providers/new")}>
              <Plus className="h-4 w-4 mr-1" /> Add
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-1">
          {providers.map((provider) => (
            <div key={provider.id} className="flex items-center gap-2 px-2 py-2 text-sm">
              <span className="font-medium">{provider.name}</span>
              {provider.isBuiltin && <span className="text-xs text-muted-foreground">(built-in)</span>}
              <span className="ml-auto text-xs text-muted-foreground">
                {provider.models.length} model{provider.models.length !== 1 ? "s" : ""}
              </span>
              {!provider.isBuiltin && (
                <>
                  <Button variant="outline" size="sm" onClick={() => router.push(`/settings/providers/${provider.id}`)}>
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={async () => {
                      await fetch(`/api/providers/${provider.id}`, { method: "DELETE" });
                      fetchProviders();
                    }}
                  >
                    Delete
                  </Button>
                </>
              )}
            </div>
          ))}
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
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Input</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingRow label="Dismiss keyboard on send">
            <Toggle
              enabled={settings.dismissKeyboardOnSend}
              onToggle={() => updateSetting("dismissKeyboardOnSend", !settings.dismissKeyboardOnSend)}
            />
          </SettingRow>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sidebar</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingRow label="Reviews" hint="Show the Reviews section in the sidebar for tracking PR reviews">
            <Toggle enabled={settings.reviewsEnabled} onToggle={() => updateSetting("reviewsEnabled", !settings.reviewsEnabled)} />
          </SettingRow>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notifications</CardTitle>
        </CardHeader>
        <CardContent className="space-y-0.5">
          <NavRow label="External providers" onClick={() => router.push("/settings/notifications")} />
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
