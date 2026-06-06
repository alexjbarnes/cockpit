"use client";

import { ChevronDown, ChevronRight, Download, ExternalLink, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";

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

function VersionCard({
  label,
  installed,
  latest,
  loading,
  onRefresh,
  onUpdate,
  updating,
  updateResult,
  updateCommand,
  installMethod,
  children,
}: {
  label: string;
  installed: string;
  latest: string;
  loading: boolean;
  onRefresh: () => void;
  onUpdate: () => void;
  updating: boolean;
  updateResult: { ok: boolean; message: string } | null;
  updateCommand?: string | null;
  installMethod?: string;
  children?: React.ReactNode;
}) {
  const outdated = installed !== "unknown" && latest !== "unknown" && installed.localeCompare(latest, undefined, { numeric: true }) < 0;

  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium">{label}</span>
          <span className="font-mono text-muted-foreground text-xs">{installed || "..."}</span>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="text-muted-foreground hover:text-foreground transition-colors p-1 shrink-0"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      {!loading && installed !== "unknown" && latest !== "unknown" && !outdated && (
        <p className="text-xs text-green-500 mt-1">Up to date</p>
      )}
      {outdated && (
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-xs text-amber-500">v{latest} available</span>
          {installMethod !== "npx" && (
            <Button size="sm" variant="outline" onClick={onUpdate} disabled={updating}>
              <Download className="h-3 w-3 mr-1" />
              {updating ? "Updating..." : "Update"}
            </Button>
          )}
        </div>
      )}
      {outdated && updateCommand && <p className="text-xs text-muted-foreground font-mono break-all mt-1.5">{updateCommand}</p>}
      {outdated && installMethod === "npx" && <p className="text-xs text-muted-foreground mt-1.5">Restart to get the latest version</p>}
      {updateResult && (
        <p className={`text-xs mt-1.5 ${updateResult.ok ? "text-green-500" : "text-destructive"}`}>{updateResult.message}</p>
      )}
      {children}
    </div>
  );
}

function ChangelogAccordion({
  releases,
  expanded,
  onToggle,
  expandedVersions,
  onToggleVersion,
  repoUrl,
  formatVersion,
}: {
  releases: Array<{ version: string; date?: string; items?: string[]; sections?: Array<{ heading: string; items: string[] }> }>;
  expanded: boolean;
  onToggle: () => void;
  expandedVersions: Set<string>;
  onToggleVersion: (v: string) => void;
  repoUrl?: string;
  formatVersion?: (v: string) => string;
}) {
  if (releases.length === 0) return null;
  return (
    <div className="mt-2 border-t border-border pt-2">
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
        What's New
      </button>
      {expanded && (
        <div className="mt-2 space-y-0.5 ml-1 border-l border-border pl-3">
          {releases.slice(0, 10).map((release) => {
            const open = expandedVersions.has(release.version);
            return (
              <div key={release.version}>
                <button
                  onClick={() => onToggleVersion(release.version)}
                  className="flex items-center justify-between w-full text-left py-1 rounded hover:bg-muted/50 transition-colors text-sm"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{formatVersion ? formatVersion(release.version) : release.version}</span>
                    {release.date && <span className="text-xs text-muted-foreground">{formatReleaseDate(release.date)}</span>}
                  </div>
                  <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
                </button>
                {open && (
                  <div className="pb-2 text-sm">
                    {release.sections?.map((section) => (
                      <div key={section.heading} className="mt-1.5">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">{section.heading}</p>
                        <ul className="space-y-1">
                          {section.items.map((item, i) => (
                            <li key={i} className="flex gap-2 text-xs">
                              <span className="text-muted-foreground mt-0.5 shrink-0">•</span>
                              <span className="break-words min-w-0">{item.replace(/\*\*/g, "")}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    {release.items && (
                      <ul className="space-y-1 mt-1">
                        {release.items.map((item, i) => (
                          <li key={i} className="flex gap-2 text-xs">
                            <span className="text-muted-foreground mt-0.5 shrink-0">•</span>
                            <span className="break-words min-w-0">{item}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {repoUrl && (
            <div className="pt-1">
              <a
                href={repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                Full changelog
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NavRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-lg px-3 py-3 text-sm hover:bg-muted/50 transition-colors"
    >
      <span>{label}</span>
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </button>
  );
}

export default function SettingsPage() {
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
  const router = useRouter();

  usePageHeader("Settings", { hideActions: true });

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

  const toggleVersion = useCallback((set: Set<string>, v: string) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  }, []);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
      <div className="max-w-lg space-y-3">
        {version && (
          <VersionCard
            label="Claude Code"
            installed={version.installed}
            latest={version.latest}
            loading={versionLoading}
            onRefresh={fetchVersion}
            onUpdate={triggerUpdate}
            updating={updating}
            updateResult={updateResult}
            updateCommand={version.updateCommand}
          >
            <ChangelogAccordion
              releases={ccReleases}
              expanded={ccChangelogExpanded}
              onToggle={() => setCcChangelogExpanded(!ccChangelogExpanded)}
              expandedVersions={ccExpandedVersions}
              onToggleVersion={(v) => setCcExpandedVersions(toggleVersion(ccExpandedVersions, v))}
              repoUrl="https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md"
            />
          </VersionCard>
        )}

        {cockpitVersion && (
          <VersionCard
            label="Cockpit"
            installed={cockpitVersion.installed}
            latest={cockpitVersion.latest}
            loading={cockpitVersionLoading}
            onRefresh={fetchCockpitVersion}
            onUpdate={triggerCockpitUpdate}
            updating={cockpitUpdating}
            updateResult={cockpitUpdateResult}
            updateCommand={cockpitVersion.updateCommand}
            installMethod={cockpitVersion.installMethod}
          >
            <ChangelogAccordion
              releases={changelogReleases}
              expanded={changelogExpanded}
              onToggle={() => setChangelogExpanded(!changelogExpanded)}
              expandedVersions={expandedVersions}
              onToggleVersion={(v) => setExpandedVersions(toggleVersion(expandedVersions, v))}
              repoUrl={changelogRepo ? `https://github.com/${changelogRepo}/blob/main/CHANGELOG.md` : undefined}
              formatVersion={(v) => `Version ${v}`}
            />
          </VersionCard>
        )}

        <div className="border-t border-border pt-4 mt-4 space-y-0.5">
          <NavRow label="Session Defaults" onClick={() => router.push("/settings/session")} />
          <NavRow label="Appearance" onClick={() => router.push("/settings/appearance")} />
          <NavRow label="Model Providers" onClick={() => router.push("/settings/providers")} />
          <NavRow label="Notifications" onClick={() => router.push("/settings/notifications")} />
          <NavRow label="Cockpit Agent" onClick={() => router.push("/settings/assistant")} />
        </div>

        <div className="border-t border-border pt-4 mt-4 space-y-0.5">
          <NavRow label="Agents" onClick={() => router.push("/agents")} />
          <NavRow label="MCP Servers" onClick={() => router.push("/mcp-servers")} />
          <NavRow label="Plugins" onClick={() => router.push("/plugins")} />
          <NavRow label="Skills" onClick={() => router.push("/skills")} />
          <NavRow label="Commands" onClick={() => router.push("/commands")} />
          <NavRow label="Hooks" onClick={() => router.push("/hooks")} />
          <NavRow label="CLAUDE.md" onClick={() => router.push("/claude-md")} />
        </div>
      </div>
    </div>
  );
}
