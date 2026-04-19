"use client";

import { ArrowLeft, Play, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { DirectoryPicker } from "@/components/directory-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useJobRuns } from "@/hooks/use-jobs";
import { describeSchedule } from "@/server/cron-utils";
import type { JobSchedule, ScheduledJob, SimpleScheduleFrequency } from "@/types";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function runStatusBadge(status: string) {
  switch (status) {
    case "success":
      return <Badge className="bg-green-600 text-white">Success</Badge>;
    case "failure":
      return <Badge variant="destructive">Failed</Badge>;
    case "timeout":
      return <Badge className="bg-yellow-600 text-white">Timeout</Badge>;
    case "running":
      return <Badge className="bg-blue-600 text-white">Running</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

export default function JobEditPage() {
  const params = useParams();
  const id = params.id as string;
  const isNew = id === "new";
  const router = useRouter();

  usePageHeader(isNew ? "New Job" : "Edit Job");

  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [scheduleType, setScheduleType] = useState<"simple" | "cron">("simple");
  const [frequency, setFrequency] = useState<SimpleScheduleFrequency>("daily");
  const [time, setTime] = useState("09:00");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [cronExpression, setCronExpression] = useState("0 9 * * *");
  const [model, setModel] = useState("");
  const [maxDuration, setMaxDuration] = useState(30);
  const [bypassPermissions, setBypassPermissions] = useState(false);
  const [allowedToolsStr, setAllowedToolsStr] = useState("");
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [availableMcp, setAvailableMcp] = useState<string[]>([]);
  const [skipIfMissed, setSkipIfMissed] = useState(false);
  const [retentionDays, setRetentionDays] = useState(90);
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loading, setLoading] = useState(!isNew);

  const { runs, loading: runsLoading, refresh: refreshRuns } = useJobRuns(isNew ? null : id);

  const loadJob = useCallback(async () => {
    if (isNew) return;
    try {
      const res = await fetch(`/api/jobs/${id}`);
      if (!res.ok) {
        router.push("/jobs");
        return;
      }
      const data = await res.json();
      const job: ScheduledJob = data.job;
      setName(job.name);
      setCwd(job.cwd);
      setPrompt(job.prompt);
      setEnabled(job.enabled);
      if (job.schedule.type === "cron") {
        setScheduleType("cron");
        setCronExpression(job.schedule.expression);
      } else {
        setScheduleType("simple");
        setFrequency(job.schedule.frequency);
        setTime(job.schedule.time || "09:00");
        setDayOfWeek(job.schedule.dayOfWeek ?? 1);
        setDayOfMonth(job.schedule.dayOfMonth ?? 1);
      }
      setModel(job.model || "");
      setMaxDuration(job.maxDurationMinutes ?? 30);
      setBypassPermissions(job.bypassPermissions ?? false);
      setAllowedToolsStr((job.allowedTools || []).join(", "));
      setMcpServers(job.mcpServers || []);
      setSkipIfMissed(job.skipIfMissed ?? false);
      setRetentionDays(job.retentionDays ?? 90);
    } finally {
      setLoading(false);
    }
  }, [id, isNew, router]);

  useEffect(() => {
    loadJob();
  }, [loadJob]);

  useEffect(() => {
    if (!cwd) return;
    fetch(`/api/jobs/mcp-discover?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((data: { servers: string[] }) => setAvailableMcp(data.servers))
      .catch(() => setAvailableMcp([]));
  }, [cwd]);

  function buildSchedule(): JobSchedule {
    if (scheduleType === "cron") {
      return { type: "cron", expression: cronExpression };
    }
    return {
      type: "simple",
      frequency,
      time,
      ...(frequency === "weekly" ? { dayOfWeek } : {}),
      ...(frequency === "monthly" ? { dayOfMonth } : {}),
    };
  }

  function schedulePreview(): string {
    try {
      return describeSchedule(buildSchedule());
    } catch {
      return "";
    }
  }

  async function handleSave() {
    setSaving(true);
    const allowedTools = allowedToolsStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const body = {
      name,
      cwd,
      prompt,
      enabled,
      schedule: buildSchedule(),
      model: model || undefined,
      maxDurationMinutes: maxDuration,
      bypassPermissions,
      allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
      mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
      skipIfMissed,
      retentionDays,
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
        if (isNew) {
          router.push(`/jobs/${data.job.id}`);
        }
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    const res = await fetch(`/api/jobs/${id}`, { method: "DELETE" });
    if (res.ok) {
      router.push("/jobs");
    }
  }

  async function handleTrigger() {
    await fetch(`/api/jobs/${id}/trigger`, { method: "POST" });
    refreshRuns();
  }

  if (loading) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => router.push("/jobs")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1" />
        {!isNew && (
          <>
            <Button variant="outline" size="sm" onClick={handleTrigger}>
              <Play className="h-4 w-4 mr-1" />
              Run Now
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4 mr-1" />
              Delete
            </Button>
          </>
        )}
      </div>

      <div className="space-y-4 max-w-2xl">
        <div>
          <label className="text-sm font-medium mb-1 block">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly dependency update" />
        </div>

        <div>
          <label className="text-sm font-medium mb-1 block">Working Directory</label>
          <div className="flex gap-2">
            <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/project" className="flex-1" />
            <Button variant="outline" size="sm" onClick={() => setShowDirPicker(true)}>
              Browse
            </Button>
          </div>
          {showDirPicker && (
            <div className="mt-2 border rounded-md p-3">
              <DirectoryPicker
                onSelect={(p) => {
                  setCwd(p);
                  setShowDirPicker(false);
                }}
                onCancel={() => setShowDirPicker(false)}
              />
            </div>
          )}
        </div>

        <div>
          <label className="text-sm font-medium mb-1 block">Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Check for outdated dependencies and create a PR updating them..."
            className="w-full min-h-[120px] rounded-md border bg-background px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div>
          <label className="text-sm font-medium mb-2 block">Schedule</label>
          <div className="flex gap-2 mb-2">
            <Button variant={scheduleType === "simple" ? "default" : "outline"} size="sm" onClick={() => setScheduleType("simple")}>
              Simple
            </Button>
            <Button variant={scheduleType === "cron" ? "default" : "outline"} size="sm" onClick={() => setScheduleType("cron")}>
              Cron
            </Button>
          </div>

          {scheduleType === "simple" ? (
            <div className="space-y-2">
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as SimpleScheduleFrequency)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
              {frequency !== "hourly" && <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />}
              {frequency === "weekly" && (
                <select
                  value={dayOfWeek}
                  onChange={(e) => setDayOfWeek(Number(e.target.value))}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                >
                  {DAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              )}
              {frequency === "monthly" && (
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={dayOfMonth}
                  onChange={(e) => setDayOfMonth(Number(e.target.value))}
                  placeholder="Day of month"
                />
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <Input
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder="0 9 * * 1-5"
                className="font-mono"
              />
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-1">{schedulePreview()}</p>
        </div>

        <div>
          <label className="text-sm font-medium mb-1 block">Model (optional)</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="">Default</option>
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
            <option value="haiku">Haiku</option>
          </select>
        </div>

        <div>
          <label className="text-sm font-medium mb-1 block">Max Duration (minutes)</label>
          <Input type="number" min={1} value={maxDuration} onChange={(e) => setMaxDuration(Number(e.target.value))} />
        </div>

        <div className="flex items-center gap-3">
          <label className="text-sm font-medium">Bypass Permissions</label>
          <button
            type="button"
            role="switch"
            aria-checked={bypassPermissions}
            onClick={() => setBypassPermissions(!bypassPermissions)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${bypassPermissions ? "bg-primary" : "bg-muted"}`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg transition-transform ${bypassPermissions ? "translate-x-5" : "translate-x-0"}`}
            />
          </button>
          <span className="text-xs text-muted-foreground">
            {bypassPermissions ? "All permissions skipped" : "Tools go through permission flow (auto-approved unless restricted)"}
          </span>
        </div>

        {!bypassPermissions && (
          <div>
            <label className="text-sm font-medium mb-1 block">Allowed Tools (comma-separated, leave empty for all)</label>
            <Input
              value={allowedToolsStr}
              onChange={(e) => setAllowedToolsStr(e.target.value)}
              placeholder="Read, Write, Bash, Grep"
              className="font-mono"
            />
          </div>
        )}

        {availableMcp.length > 0 && (
          <div>
            <label className="text-sm font-medium mb-1 block">MCP Servers</label>
            <div className="space-y-1">
              {availableMcp.map((server) => (
                <label key={server} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={mcpServers.includes(server)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setMcpServers([...mcpServers, server]);
                      } else {
                        setMcpServers(mcpServers.filter((s) => s !== server));
                      }
                    }}
                    className="rounded"
                  />
                  <span className="font-mono">{server}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-1">When none selected, all servers are active.</p>
          </div>
        )}

        <div className="flex items-center gap-3">
          <label className="text-sm font-medium">Skip Missed Runs</label>
          <button
            type="button"
            role="switch"
            aria-checked={skipIfMissed}
            onClick={() => setSkipIfMissed(!skipIfMissed)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${skipIfMissed ? "bg-primary" : "bg-muted"}`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg transition-transform ${skipIfMissed ? "translate-x-5" : "translate-x-0"}`}
            />
          </button>
          <span className="text-xs text-muted-foreground">
            {skipIfMissed ? "Missed runs are skipped" : "Catch up on missed runs (up to 24h)"}
          </span>
        </div>

        <div>
          <label className="text-sm font-medium mb-1 block">Retention (days)</label>
          <Input type="number" min={1} value={retentionDays} onChange={(e) => setRetentionDays(Number(e.target.value))} />
        </div>

        <div className="flex items-center gap-3">
          <label className="text-sm font-medium">Enabled</label>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled(!enabled)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${enabled ? "bg-primary" : "bg-muted"}`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg transition-transform ${enabled ? "translate-x-5" : "translate-x-0"}`}
            />
          </button>
        </div>

        <div className="flex gap-2 pt-2">
          <Button onClick={handleSave} disabled={saving || !name || !cwd || !prompt}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button variant="outline" onClick={() => router.push("/jobs")}>
            Cancel
          </Button>
        </div>
      </div>

      {!isNew && (
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle className="text-base">Run History</CardTitle>
          </CardHeader>
          <CardContent>
            {runsLoading && <p className="text-sm text-muted-foreground">Loading runs...</p>}
            {!runsLoading && runs.length === 0 && <p className="text-sm text-muted-foreground">No runs yet.</p>}
            <div className="space-y-1">
              {runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className="w-full flex items-center gap-3 rounded px-2 py-2 hover:bg-muted transition-colors text-left"
                  onClick={() => router.push(`/jobs/${id}/runs/${run.id}`)}
                >
                  {runStatusBadge(run.status)}
                  <span className="text-xs text-muted-foreground flex-1">{new Date(run.startedAt).toLocaleString()}</span>
                  {run.durationMs != null && <span className="text-xs text-muted-foreground">{Math.round(run.durationMs / 1000)}s</span>}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Job</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">Delete this job and all run history? This cannot be undone.</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
