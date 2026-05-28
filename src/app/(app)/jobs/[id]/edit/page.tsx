"use client";

import { ArrowLeft, Plus, X } from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { DirectoryPicker } from "@/components/directory-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  allowedEffortLevels,
  CONTEXT_SIZES,
  type ContextSize,
  defaultForAlias,
  findModelById,
  type ModelAlias,
  recommendedEffort,
  resolveModel,
  versionsForAlias,
} from "@/lib/models";
import { describeSchedule, getJobSchedules } from "@/server/cron-utils";
import type { JobSchedule, Provider, ProviderModel, ScheduledJob, SimpleSchedule, SimpleScheduleFrequency, ThinkingLevel } from "@/types";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const COMMON_TOOLS = ["Read", "Write", "Edit", "Bash", "Bash git", "Bash npm", "Bash ls", "Grep", "Glob", "Agent", "WebFetch", "WebSearch"];

const THINKING_LABELS: Record<ThinkingLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

const DEFAULT_MODEL_ID = defaultForAlias("sonnet")?.modelId || "";

const SELECT_CLASS = "w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${checked ? "bg-primary" : "bg-muted"}`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg transition-transform ${checked ? "translate-x-4" : "translate-x-0"}`}
      />
    </button>
  );
}

function ScheduleEntry({
  value,
  onChange,
  onRemove,
  canRemove,
}: {
  value: JobSchedule;
  onChange: (s: JobSchedule) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const isSimple = value.type === "simple";

  return (
    <div className="border rounded-md p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Button
            variant={isSimple ? "default" : "outline"}
            size="sm"
            onClick={() => onChange({ type: "simple", frequency: "daily", time: "09:00" })}
          >
            Simple
          </Button>
          <Button variant={!isSimple ? "default" : "outline"} size="sm" onClick={() => onChange({ type: "cron", expression: "0 9 * * *" })}>
            Cron
          </Button>
        </div>
        {canRemove && (
          <button type="button" onClick={onRemove} className="text-muted-foreground hover:text-destructive">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {isSimple ? (
        <div className="space-y-2">
          <select
            value={(value as SimpleSchedule).frequency}
            onChange={(e) => onChange({ ...value, frequency: e.target.value as SimpleScheduleFrequency })}
            className={SELECT_CLASS}
          >
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
          {(value as SimpleSchedule).frequency !== "hourly" && (
            <Input
              type="time"
              value={(value as SimpleSchedule).time || "09:00"}
              onChange={(e) => onChange({ ...value, time: e.target.value })}
            />
          )}
          {(value as SimpleSchedule).frequency === "weekly" && (
            <select
              value={(value as SimpleSchedule).dayOfWeek ?? 1}
              onChange={(e) => onChange({ ...value, dayOfWeek: Number(e.target.value) })}
              className={SELECT_CLASS}
            >
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          )}
          {(value as SimpleSchedule).frequency === "monthly" && (
            <Input
              type="number"
              min={1}
              max={31}
              value={(value as SimpleSchedule).dayOfMonth ?? 1}
              onChange={(e) => onChange({ ...value, dayOfMonth: Number(e.target.value) })}
              placeholder="Day of month"
            />
          )}
        </div>
      ) : (
        <Input
          value={(value as { expression: string }).expression}
          onChange={(e) => onChange({ type: "cron", expression: e.target.value })}
          placeholder="0 9 * * 1-5"
          className="font-mono"
        />
      )}
      <p className="text-xs text-muted-foreground">{describeSchedule(value)}</p>
    </div>
  );
}

export default function JobEditPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const isNew = id === "new";
  const duplicateFrom = isNew ? searchParams.get("from") : null;
  const initialCwd = isNew ? searchParams.get("cwd") : null;
  const router = useRouter();

  usePageHeader(duplicateFrom ? "Duplicate Job" : isNew ? "New Job" : "Edit Job", { hideActions: true });

  const [name, setName] = useState("");
  const [cwd, setCwd] = useState(initialCwd || "");
  const [prompt, setPrompt] = useState("");
  const [enabled, setEnabled] = useState(true);

  const [schedules, setSchedules] = useState<JobSchedule[]>([{ type: "simple", frequency: "daily", time: "09:00" }]);

  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [contextSize, setContextSize] = useState<ContextSize>("200k");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | "">("medium");
  const [selectedProviderId, setSelectedProviderId] = useState("anthropic");
  const [runtime, setRuntime] = useState<"stream" | "pty">("stream");

  const [maxDuration, setMaxDuration] = useState(30);
  const [bypassPermissions, setBypassPermissions] = useState(false);
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [toolInput, setToolInput] = useState("");

  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [mcpToolFilters, setMcpToolFilters] = useState<Record<string, string[]>>({});
  const [mcpFilterInputs, setMcpFilterInputs] = useState<Record<string, string>>({});
  const [expandedMcpFilters, setExpandedMcpFilters] = useState<Set<string>>(new Set());
  const [availableMcp, setAvailableMcp] = useState<string[]>([]);
  const [skipIfMissed, setSkipIfMissed] = useState(false);
  const [retentionDays, setRetentionDays] = useState(90);
  const [inboxOutput, setInboxOutput] = useState(false);
  const [notifyProviders, setNotifyProviders] = useState<string[]>([]);
  const [availableProviders, setAvailableProviders] = useState<{ id: string; name: string; type: string }[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);

  const [showDirPicker, setShowDirPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!isNew || !!duplicateFrom);

  const isBuiltinProvider = selectedProviderId === "anthropic";
  const selectedProvider = providers.find((p) => p.id === selectedProviderId);
  const selectedEntry = isBuiltinProvider && modelId ? findModelById(modelId) : null;
  const selectedAlias = selectedEntry?.alias || null;
  const availableVersions = selectedAlias ? versionsForAlias(selectedAlias) : [];
  const showVersions = availableVersions.length > 1;
  const customProviderModel = !isBuiltinProvider && selectedProvider ? selectedProvider.models.find((m) => m.modelId === modelId) : null;
  const contextSizes = useMemo<ContextSize[]>(
    () => (isBuiltinProvider ? (selectedEntry?.contextSizes ?? ["200k"]) : (customProviderModel?.contextSizes ?? ["200k"])),
    [isBuiltinProvider, selectedEntry, customProviderModel],
  );

  useEffect(() => {
    if (!contextSizes.includes(contextSize)) {
      setContextSize(contextSizes[0] ?? "200k");
    }
  }, [contextSizes, contextSize]);

  const effortLevels = (() => {
    if (!isBuiltinProvider && customProviderModel) return customProviderModel.effortLevels;
    const base = modelId.replace(/\[.*\]$/, "");
    for (const p of providers) {
      const m = p.models.find((pm) => pm.modelId === base);
      if (m && m.effortLevels.length > 0) return m.effortLevels;
    }
    return selectedEntry ? allowedEffortLevels(selectedEntry) : [];
  })();
  const toolSuggestions = COMMON_TOOLS.filter((t) => !allowedTools.includes(t));
  const customProviders = providers.filter((p) => !p.isBuiltin);

  function selectAlias(alias: ModelAlias) {
    const entry = defaultForAlias(alias);
    if (entry) {
      setSelectedProviderId("anthropic");
      setModelId(entry.modelId);
      setContextSize("200k");
      const rec = recommendedEffort(entry);
      setThinkingLevel(rec || "");
    }
  }

  function selectCustomProvider(providerId: string) {
    setSelectedProviderId(providerId);
    const provider = providers.find((p) => p.id === providerId);
    if (provider && provider.models.length > 0) {
      const first = provider.models[0];
      setModelId(first.modelId);
      setContextSize("200k");
      setThinkingLevel(first.defaultEffort || (first.effortLevels.length > 0 ? first.effortLevels[0] : ""));
    }
  }

  function selectCustomModel(model: ProviderModel) {
    setModelId(model.modelId);
    setContextSize("200k");
    setThinkingLevel(model.defaultEffort || (model.effortLevels.length > 0 ? model.effortLevels[0] : ""));
  }

  function selectVersion(version: string) {
    if (!selectedAlias) return;
    const entry = versionsForAlias(selectedAlias).find((m) => m.version === version);
    if (entry) {
      setModelId(entry.modelId);
      const provLevels = (() => {
        for (const p of providers) {
          const m = p.models.find((pm) => pm.modelId === entry.modelId);
          if (m) return m.effortLevels;
        }
        return [];
      })();
      const levels = provLevels.length > 0 ? provLevels : allowedEffortLevels(entry);
      if (thinkingLevel && !levels.includes(thinkingLevel as ThinkingLevel)) {
        setThinkingLevel(recommendedEffort(entry) || "");
      }
    }
  }

  function addTool(tool: string) {
    const trimmed = tool.trim();
    if (trimmed && !allowedTools.includes(trimmed)) {
      setAllowedTools([...allowedTools, trimmed]);
    }
    setToolInput("");
  }

  function removeTool(tool: string) {
    setAllowedTools(allowedTools.filter((t) => t !== tool));
  }

  const applyJob = useCallback((job: ScheduledJob, isDuplicate: boolean) => {
    setName(isDuplicate ? `${job.name} (copy)` : job.name);
    setCwd(job.cwd);
    setPrompt(job.prompt);
    setEnabled(job.enabled);
    setSchedules(getJobSchedules(job));
    const rawModel = job.model || "";
    const withoutExt = rawModel.replace(/\[.*\]$/, "");
    const colonIdx = withoutExt.indexOf(":");
    if (colonIdx > 0) {
      setSelectedProviderId(withoutExt.slice(0, colonIdx));
      setModelId(withoutExt.slice(colonIdx + 1));
    } else {
      setSelectedProviderId("anthropic");
      const entry = resolveModel(withoutExt);
      setModelId(entry?.modelId || DEFAULT_MODEL_ID);
    }
    const legacy1m = /\[1m\]$/i.test(rawModel);
    setContextSize(job.contextSize ?? (legacy1m ? "1m" : "200k"));
    const builtinEntry = resolveModel(withoutExt);
    setThinkingLevel(job.thinkingLevel || recommendedEffort(builtinEntry) || "");
    setMaxDuration(job.maxDurationMinutes ?? 30);
    setBypassPermissions(job.bypassPermissions ?? false);
    setAllowedTools(job.allowedTools || []);
    setMcpServers(job.mcpServers || []);
    setMcpToolFilters(job.mcpToolFilters || {});
    setSkipIfMissed(job.skipIfMissed ?? false);
    setRetentionDays(job.retentionDays ?? 90);
    setInboxOutput(job.inboxOutput ?? false);
    setNotifyProviders(job.notifyProviders || []);
    setRuntime(job.runtime || "stream");
  }, []);

  const loadJob = useCallback(async () => {
    const fetchId = duplicateFrom || (isNew ? null : id);
    if (!fetchId) return;
    try {
      const res = await fetch(`/api/jobs/${fetchId}`);
      if (!res.ok) {
        router.push("/jobs");
        return;
      }
      const data = await res.json();
      applyJob(data.job, !!duplicateFrom);
    } finally {
      setLoading(false);
    }
  }, [id, isNew, duplicateFrom, router, applyJob]);

  useEffect(() => {
    loadJob();
  }, [loadJob]);

  useEffect(() => {
    const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    fetch(`/api/jobs/mcp-discover${params}`)
      .then((r) => r.json())
      .then((data: { servers: string[] }) => setAvailableMcp(data.servers))
      .catch(() => setAvailableMcp([]));
  }, [cwd]);

  useEffect(() => {
    fetch("/api/notifications")
      .then((r) => r.json())
      .then((data: { providers: { id: string; name: string; type: string; enabled: boolean }[] }) =>
        setAvailableProviders((data.providers || []).filter((p) => p.enabled)),
      )
      .catch(() => setAvailableProviders([]));
  }, []);

  useEffect(() => {
    fetch("/api/providers")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setProviders(data);
      })
      .catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    let modelStr = modelId;
    if (!isBuiltinProvider && selectedProviderId) {
      modelStr = `${selectedProviderId}:${modelId}`;
    }

    const body = {
      name,
      cwd,
      prompt,
      enabled,
      schedule: schedules[0],
      schedules,
      model: modelStr,
      contextSize,
      thinkingLevel: thinkingLevel || undefined,
      maxDurationMinutes: maxDuration,
      bypassPermissions,
      allowedTools,
      mcpServers,
      mcpToolFilters,
      skipIfMissed,
      retentionDays,
      inboxOutput,
      notifyProviders,
      runtime,
    };

    try {
      const url = isNew ? "/api/jobs" : `/api/jobs/${id}`;
      const method = isNew ? "POST" : "PUT";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        const savedId = isNew ? data.job.id : id;
        router.push(`/jobs/${savedId}`);
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto space-y-4 pb-8">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => router.push(isNew ? "/jobs" : `/jobs/${id}`)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h2 className="font-semibold">{duplicateFrom ? "Duplicate Job" : isNew ? "New Job" : "Edit Job"}</h2>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly dependency update" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Prompt</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Check for outdated dependencies and create a PR updating them..."
                className="w-full min-h-[120px] rounded-md border bg-background px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Working Directory</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex gap-2">
              <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="Leave empty for scratchpad" className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => setShowDirPicker(true)}>
                Browse
              </Button>
            </div>
            {!cwd && <p className="text-xs text-muted-foreground">Uses ~/.cockpit/jobs as a temporary scratchpad directory</p>}
            {showDirPicker && (
              <div className="border rounded-md p-3">
                <DirectoryPicker
                  onSelect={(p) => {
                    setCwd(p);
                    setShowDirPicker(false);
                  }}
                  onCancel={() => setShowDirPicker(false)}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Schedule</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {schedules.map((sched, i) => (
              <ScheduleEntry
                key={i}
                value={sched}
                onChange={(s) => setSchedules(schedules.map((prev, j) => (j === i ? s : prev)))}
                onRemove={() => setSchedules(schedules.filter((_, j) => j !== i))}
                canRemove={schedules.length > 1}
              />
            ))}
            <button
              type="button"
              onClick={() => setSchedules([...schedules, { type: "simple", frequency: "daily", time: "09:00" }])}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              <Plus className="h-3 w-3" />
              Add schedule
            </button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Model</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex flex-col gap-1.5 px-2 py-2 text-sm">
              <span>Provider</span>
              <select
                value={selectedProviderId}
                onChange={(e) => {
                  if (e.target.value === "anthropic") {
                    const entry = findModelById(modelId);
                    if (!entry) selectAlias("sonnet");
                    else setSelectedProviderId("anthropic");
                  } else {
                    selectCustomProvider(e.target.value);
                  }
                }}
                className={SELECT_CLASS}
              >
                <option value="anthropic">Anthropic</option>
                {customProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            {isBuiltinProvider && (
              <div className="flex items-center justify-between px-2 py-2 text-sm">
                <span>Model</span>
                <div className="flex gap-1 flex-wrap justify-end">
                  {(["haiku", "sonnet", "opus"] as ModelAlias[]).map((alias) => (
                    <Button
                      key={alias}
                      variant={selectedAlias === alias ? "default" : "outline"}
                      size="sm"
                      onClick={() => selectAlias(alias)}
                    >
                      {alias.charAt(0).toUpperCase() + alias.slice(1)}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {!isBuiltinProvider && selectedProvider && (
              <div className="flex items-center justify-between px-2 py-2 text-sm">
                <span>Model</span>
                <div className="flex gap-1 flex-wrap justify-end">
                  {selectedProvider.models.map((m) => (
                    <Button
                      key={m.modelId}
                      variant={modelId === m.modelId ? "default" : "outline"}
                      size="sm"
                      onClick={() => selectCustomModel(m)}
                    >
                      {m.displayName}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {isBuiltinProvider && showVersions && (
              <div className="flex items-center justify-between px-2 py-2 text-sm">
                <span>Version</span>
                <div className="flex gap-1 flex-wrap justify-end">
                  {availableVersions.map((entry) => (
                    <Button
                      key={entry.version}
                      variant={selectedEntry?.version === entry.version ? "default" : "outline"}
                      size="sm"
                      onClick={() => selectVersion(entry.version)}
                    >
                      {entry.version}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {contextSizes.length >= 2 && (
              <div className="flex items-center justify-between px-2 py-2 text-sm">
                <span>Context</span>
                <div className="flex gap-1">
                  {contextSizes.map((size) => (
                    <Button
                      key={size}
                      variant={contextSize === size ? "default" : "outline"}
                      size="sm"
                      onClick={() => setContextSize(size)}
                    >
                      {CONTEXT_SIZES[size].label}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {effortLevels.length > 0 && (
              <div className="flex items-center justify-between px-2 py-2 text-sm">
                <span>Thinking</span>
                <div className="flex gap-1 flex-wrap justify-end">
                  {effortLevels.map((level) => (
                    <Button
                      key={level}
                      variant={thinkingLevel === level ? "default" : "outline"}
                      size="sm"
                      onClick={() => setThinkingLevel(level)}
                    >
                      {THINKING_LABELS[level]}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Permissions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium">Bypass Permissions</label>
                {bypassPermissions && <p className="text-xs text-muted-foreground">All tool permissions will be auto-approved</p>}
              </div>
              <Toggle checked={bypassPermissions} onChange={setBypassPermissions} />
            </div>

            {!bypassPermissions && (
              <div className="space-y-2 border-t pt-4">
                <label className="text-sm font-medium">Allowed Tools</label>
                {allowedTools.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {allowedTools.map((tool) => (
                      <span
                        key={tool}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-primary/10 text-primary font-mono"
                      >
                        {tool}
                        <button type="button" onClick={() => removeTool(tool)} className="hover:text-destructive">
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <Input
                    value={toolInput}
                    onChange={(e) => setToolInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTool(toolInput);
                      }
                    }}
                    placeholder="Type tool name and press Enter"
                    className="flex-1 font-mono"
                  />
                  <Button variant="outline" size="sm" onClick={() => addTool(toolInput)} disabled={!toolInput.trim()}>
                    Add
                  </Button>
                </div>
                {toolSuggestions.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {toolSuggestions.map((tool) => (
                      <button
                        key={tool}
                        type="button"
                        onClick={() => addTool(tool)}
                        className="text-xs px-2 py-0.5 rounded border border-dashed border-muted-foreground/30 text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                      >
                        + {tool}
                      </button>
                    ))}
                  </div>
                )}
                {allowedTools.length === 0 && (
                  <p className="text-xs text-muted-foreground">No tools permitted. Add tools this job is allowed to use.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">MCP Servers</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {availableMcp.length === 0 && (
              <p className="text-xs text-muted-foreground">No MCP servers found. Configure servers in Settings.</p>
            )}
            {availableMcp.length > 0 && (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {availableMcp.map((server) => {
                    const active = mcpServers.includes(server);
                    return (
                      <button
                        key={server}
                        type="button"
                        onClick={() => {
                          if (active) {
                            setMcpServers(mcpServers.filter((s) => s !== server));
                            const { [server]: _, ...rest } = mcpToolFilters;
                            setMcpToolFilters(rest);
                            setExpandedMcpFilters((prev) => {
                              const next = new Set(prev);
                              next.delete(server);
                              return next;
                            });
                          } else {
                            setMcpServers([...mcpServers, server]);
                          }
                        }}
                        className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md font-mono transition-colors ${active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"}`}
                      >
                        {server}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  {mcpServers.length === 0 ? "No servers enabled. Select servers to activate." : `${mcpServers.length} enabled.`}
                </p>
                {mcpServers.map((server) => {
                  const filters = mcpToolFilters[server] || [];
                  const expanded = expandedMcpFilters.has(server);
                  const filterInput = mcpFilterInputs[server] || "";
                  return (
                    <div key={server} className="border rounded-md p-2 space-y-2">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedMcpFilters((prev) => {
                            const next = new Set(prev);
                            if (next.has(server)) next.delete(server);
                            else next.add(server);
                            return next;
                          })
                        }
                        className="w-full flex items-center justify-between text-xs text-muted-foreground hover:text-primary"
                      >
                        <span className="font-mono">{server}</span>
                        <span>
                          {filters.length === 0 ? "All tools" : `${filters.length} tool${filters.length === 1 ? "" : "s"} filtered`}
                        </span>
                      </button>
                      {expanded && (
                        <div className="space-y-2 pt-1">
                          {filters.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {filters.map((f) => (
                                <span
                                  key={f}
                                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-primary/10 text-primary font-mono"
                                >
                                  {f}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const remaining = filters.filter((x) => x !== f);
                                      if (remaining.length === 0) {
                                        const { [server]: _, ...rest } = mcpToolFilters;
                                        setMcpToolFilters(rest);
                                      } else {
                                        setMcpToolFilters({ ...mcpToolFilters, [server]: remaining });
                                      }
                                    }}
                                    className="hover:text-destructive"
                                  >
                                    <X className="h-3 w-3" />
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="flex gap-2">
                            <Input
                              value={filterInput}
                              onChange={(e) => setMcpFilterInputs({ ...mcpFilterInputs, [server]: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  const val = filterInput.trim();
                                  if (val && !filters.includes(val)) {
                                    setMcpToolFilters({ ...mcpToolFilters, [server]: [...filters, val] });
                                    setMcpFilterInputs({ ...mcpFilterInputs, [server]: "" });
                                  }
                                }
                              }}
                              placeholder="Tool name or server:tool"
                              className="flex-1 font-mono text-xs"
                            />
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                const val = filterInput.trim();
                                if (val && !filters.includes(val)) {
                                  setMcpToolFilters({ ...mcpToolFilters, [server]: [...filters, val] });
                                  setMcpFilterInputs({ ...mcpFilterInputs, [server]: "" });
                                }
                              }}
                              disabled={!filterInput.trim()}
                            >
                              Add
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Leave empty to allow all tools. For proxy servers, use server:tool format.
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Execution</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Runtime</label>
              <div className="flex gap-1">
                <Button variant={runtime === "stream" ? "default" : "outline"} size="sm" onClick={() => setRuntime("stream")}>
                  Stream
                </Button>
                <Button variant={runtime === "pty" ? "default" : "outline"} size="sm" onClick={() => setRuntime("pty")}>
                  PTY
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Max Duration (minutes)</label>
              <Input type="number" min={1} value={maxDuration} onChange={(e) => setMaxDuration(Number(e.target.value))} />
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Retry missed runs</label>
              <Toggle checked={!skipIfMissed} onChange={(v) => setSkipIfMissed(!v)} />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Audit log retention (days)</label>
              <Input type="number" min={1} value={retentionDays} onChange={(e) => setRetentionDays(Number(e.target.value))} />
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Enabled</label>
              <Toggle checked={enabled} onChange={setEnabled} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Output</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium">Send to Inbox</label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  The agent will format its final output as a structured message delivered to your Cockpit inbox.
                </p>
              </div>
              <Toggle checked={inboxOutput} onChange={setInboxOutput} />
            </div>
            {inboxOutput && availableProviders.length > 0 && (
              <div className="mt-4 pt-4 border-t">
                <label className="text-sm font-medium">External notifications</label>
                <p className="text-xs text-muted-foreground mt-0.5 mb-2">Also send to these providers when a message is delivered.</p>
                <div className="space-y-1.5">
                  {availableProviders.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={notifyProviders.includes(p.id)}
                        onChange={(e) =>
                          setNotifyProviders((prev) => (e.target.checked ? [...prev, p.id] : prev.filter((x) => x !== p.id)))
                        }
                        className="rounded border-input"
                      />
                      <span>{p.name}</span>
                      <span className="text-xs text-muted-foreground">({p.type})</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving || !name || !prompt}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button variant="outline" onClick={() => router.push(isNew ? "/jobs" : `/jobs/${id}`)}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
