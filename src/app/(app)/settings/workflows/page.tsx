"use client";

import { ArrowLeft, ChevronRight, Loader2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CountField } from "@/components/workflows/count-field";
import { TrackSummary } from "@/components/workflows/status-path";
import { useSettings } from "@/hooks/use-settings";
import { ISSUE_STATUSES, resolveProjectStatuses } from "@/lib/issue-display";
import type { Project, Workflow, WorkflowStatusRule } from "@/types";

type WorkflowSource = { kind: "own" } | { kind: "reusable"; id: string; name: string } | { kind: "missing"; id: string } | { kind: "none" };

interface ListedProject {
  id: string;
  name: string;
  prefix: string;
  repoPath: string | null;
  workflow: Workflow | null;
  source: WorkflowSource;
}

interface ListedReusable {
  id: string;
  name: string;
  enabled: boolean;
  maxParallel: number;
  statuses: Record<string, WorkflowStatusRule>;
  usedBy: string[];
}

function Toggle({
  checked,
  onChange,
  testId,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      data-testid={testId}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${checked ? "bg-primary" : "bg-muted"}`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg transition-transform ${checked ? "translate-x-4" : "translate-x-0"}`}
      />
    </button>
  );
}

export default function WorkflowsSettingsPage() {
  usePageHeader("Workflows", { hideActions: true });
  const router = useRouter();
  const { settings, loaded, updateSetting } = useSettings();
  const [listed, setListed] = useState<ListedProject[] | null>(null);
  const [reusable, setReusable] = useState<ListedReusable[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [workflows, all] = await Promise.all([fetch("/api/workflows"), fetch("/api/projects")]);
      if (workflows.ok) {
        const data = (await workflows.json()) as { projects?: ListedProject[]; reusable?: ListedReusable[] };
        setListed(data.projects ?? []);
        setReusable(data.reusable ?? []);
      }
      if (all.ok) setProjects(((await all.json()).projects ?? []) as Project[]);
    } catch {
      setListed([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (loaded && !settings.issuesEnabled) router.replace("/settings");
  }, [loaded, settings.issuesEnabled, router]);

  async function createReusable() {
    const name = newName.trim();
    if (!name) return;
    setSaving(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/reusable-workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) {
        setCreateError(body.error || "Could not create the workflow");
        return;
      }
      const workflow = body.workflow as { id: string };
      setCreating(false);
      setNewName("");
      router.push(`/settings/workflows/reusable/${workflow.id}`);
    } catch {
      setCreateError("Could not reach Cockpit");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded || !settings.issuesEnabled) return null;

  const orderOf = (id: string) => resolveProjectStatuses(projects.find((p) => p.id === id)).map((s) => s.name);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto max-w-2xl space-y-6">
        <Button variant="ghost" size="sm" onClick={() => router.push("/settings")}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          Settings
        </Button>

        <header className="space-y-1">
          <h1 className="text-xl font-semibold">Workflows</h1>
          <p className="text-sm text-muted-foreground">
            A workflow is the path a project's issues take across its board. At each status on the path an agent runs one of the project's
            skills on the issue, or it waits for you. Experimental.
          </p>
        </header>

        <section className="rounded-lg border bg-card">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Switch workflows on</div>
              <p className="text-xs text-muted-foreground">Agents start by themselves when an issue reaches a status they work at.</p>
            </div>
            <Toggle
              label="Switch workflows on"
              checked={settings.workflowsEnabled}
              onChange={(v) => updateSetting("workflowsEnabled", v)}
              testId="workflows-enabled"
            />
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Reusable workflows</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Defined once and selected by several projects. A status added here reaches every project using it.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCreateError(null);
                setCreating(true);
              }}
              data-testid="reusable-workflow-new"
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              New
            </Button>
          </div>
          {reusable.length === 0 && (
            <p
              className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
              data-testid="reusable-workflows-empty"
            >
              No reusable workflows yet.
            </p>
          )}
          {reusable.map((workflow) => (
            <button
              key={workflow.id}
              type="button"
              onClick={() => router.push(`/settings/workflows/reusable/${workflow.id}`)}
              data-testid={`reusable-workflow-${workflow.id}`}
              className="flex w-full items-center gap-3 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent/40"
            >
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-semibold">{workflow.name}</span>
                  {!workflow.enabled && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">Off</span>}
                  <span className="text-xs text-muted-foreground">
                    {workflow.usedBy.length === 0 ? "Not used yet" : `Used by ${workflow.usedBy.join(", ")}`}
                  </span>
                </div>
                <TrackSummary rules={workflow.statuses} order={ISSUE_STATUSES} />
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold">Projects</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Each project uses its own workflow or a reusable one it selects. Its own rules are edited here; a reusable one is edited in
              its card above.
            </p>
          </div>
          {listed === null && <p className="text-sm text-muted-foreground">Loading…</p>}
          {listed?.length === 0 && (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground" data-testid="workflows-empty">
              No projects yet. Make one in Settings, Projects.
            </p>
          )}
          {(listed ?? []).map((p) =>
            p.workflow ? (
              <button
                key={p.id}
                type="button"
                onClick={() => router.push(`/settings/workflows/${p.id}`)}
                data-testid={`workflow-${p.prefix}`}
                className="flex w-full items-center gap-3 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent/40"
              >
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-semibold">{p.name}</span>
                    {!p.workflow.enabled && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">Off</span>}
                    {p.source.kind === "reusable" && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">Shared: {p.source.name}</span>
                    )}
                    {p.source.kind === "missing" && (
                      <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive">Shared workflow missing</span>
                    )}
                  </div>
                  <TrackSummary rules={p.workflow.statuses} order={orderOf(p.id)} />
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ) : (
              <div key={p.id} className="flex items-center gap-3 rounded-lg border bg-card p-4" data-testid={`workflow-${p.prefix}`}>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{p.name}</div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {p.source.kind === "missing"
                      ? "Its shared workflow no longer exists. Choose its own workflow or another one."
                      : p.repoPath
                        ? "No workflow yet. Its issues only move when you move them."
                        : "No repo path, so there is nowhere to read skills from."}
                  </p>
                </div>
                {p.repoPath && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => router.push(`/settings/workflows/${p.id}`)}
                    data-testid={`workflow-setup-${p.prefix}`}
                  >
                    Set up
                  </Button>
                )}
              </div>
            ),
          )}
        </section>

        <section className="divide-y rounded-lg border bg-card">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Pause everything</div>
              <p className="text-xs text-muted-foreground">Agents already working finish. Nothing new starts until you resume.</p>
            </div>
            <Toggle
              label="Pause everything"
              checked={settings.workflowsPaused}
              onChange={(v) => updateSetting("workflowsPaused", v)}
              testId="workflows-paused"
            />
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Agents working at once</div>
              <p className="text-xs text-muted-foreground">Across every workflow. Each is a full Claude session, about 350 MB.</p>
            </div>
            <CountField
              className="w-16 text-center"
              testId="workflows-max-parallel"
              label="Agents working at once"
              value={settings.workflowMaxParallel}
              min={1}
              max={20}
              onCommit={(n) => updateSetting("workflowMaxParallel", n)}
            />
          </div>
        </section>
      </div>

      <Dialog open={creating} onOpenChange={(open) => !saving && setCreating(open)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New reusable workflow</DialogTitle>
          </DialogHeader>
          <p className="mt-2 text-sm text-muted-foreground">
            Give it a name. You can set its statuses and rules on the next screen, then select it from a project in Settings, Projects.
          </p>
          <Input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createReusable();
            }}
            placeholder="e.g. Frontend"
            className="mt-3"
            data-testid="reusable-workflow-name"
          />
          {createError && <p className="mt-2 text-sm text-destructive">{createError}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreating(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={createReusable} disabled={saving || !newName.trim()} data-testid="reusable-workflow-create">
              {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
