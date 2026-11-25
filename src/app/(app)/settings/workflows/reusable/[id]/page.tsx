"use client";

import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { CountField } from "@/components/workflows/count-field";
import type { RepoSkillView } from "@/components/workflows/skill-select";
import { StatusEditor, type StatusEditorData } from "@/components/workflows/status-editor";
import { StatusPath } from "@/components/workflows/status-path";
import { useSettings } from "@/hooks/use-settings";
import { statusRows } from "@/lib/workflow-display";
import type { Provider, ReusableWorkflow, Workflow, WorkflowStatusRule } from "@/types";

interface Draft {
  name: string;
  enabled: boolean;
  maxParallel: number;
  statuses: Record<string, WorkflowStatusRule>;
}

interface UsedBy {
  id: string;
  name: string;
  prefix: string;
  problems: string[];
}

interface View {
  workflow: ReusableWorkflow;
  usedBy: UsedBy[];
  skills: RepoSkillView[];
  statuses: string[];
}

interface OtherProject {
  id: string;
  name: string;
  workflow: Workflow | null;
}

const BLANK: Draft = { name: "", enabled: true, maxParallel: 2, statuses: {} };

function draftOf(workflow: ReusableWorkflow): Draft {
  return { name: workflow.name, enabled: workflow.enabled, maxParallel: workflow.maxParallel, statuses: workflow.statuses };
}

/**
 * One reusable workflow: its name, its per-project limits and what happens at
 * each status. The same statuses and rules reach every project that selects it.
 */
export default function ReusableWorkflowEditPage() {
  usePageHeader("Workflow", { hideActions: true });
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { settings, loaded } = useSettings();
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [saved, setSaved] = useState(JSON.stringify(BLANK));
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [others, setOthers] = useState<OtherProject[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [notifyTargets, setNotifyTargets] = useState<StatusEditorData["notifyTargets"]>([]);

  const take = useCallback((next: View) => {
    setView(next);
    const d = draftOf(next.workflow);
    setDraft(d);
    setSaved(JSON.stringify(d));
  }, []);

  useEffect(() => {
    fetch(`/api/reusable-workflows/${id}`)
      .then(async (res) => {
        if (!res.ok) return setMissing(true);
        take((await res.json()) as View);
      })
      .catch(() => setMissing(true));
    fetch("/api/workflows")
      .then((r) => r.json())
      .then((d: { projects?: OtherProject[] }) => setOthers((d.projects ?? []).filter((p) => p.workflow)))
      .catch(() => {});
    fetch("/api/providers")
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setProviders(d))
      .catch(() => {});
    fetch("/api/jobs/mcp-discover")
      .then((r) => r.json())
      .then((d: { servers?: string[] }) => setMcpServers((d.servers ?? []).filter((s) => s !== "cockpit-config")))
      .catch(() => {});
    fetch("/api/notifications")
      .then((r) => r.json())
      .then((d: { providers?: { id: string; name: string; type: string; enabled: boolean }[] }) =>
        setNotifyTargets((d.providers ?? []).filter((p) => p.enabled)),
      )
      .catch(() => {});
  }, [id, take]);

  useEffect(() => {
    if (loaded && !settings.issuesEnabled) router.replace("/settings");
  }, [loaded, settings.issuesEnabled, router]);

  const statuses = useMemo(() => {
    const all = new Set<string>(view?.statuses ?? []);
    for (const [status, rule] of Object.entries(draft.statuses)) {
      all.add(status);
      if (rule.kind === "queue") {
        if (rule.to) all.add(rule.to);
      } else if (rule.kind === "agent") {
        for (const s of rule.next) if (s) all.add(s);
      } else {
        for (const c of rule.next) if (c.status) all.add(c.status);
      }
    }
    return [...all];
  }, [view, draft]);

  const rows = useMemo(() => statusRows(draft.statuses, statuses), [draft, statuses]);
  const missingSkills = useMemo(() => {
    const have = new Set((view?.skills ?? []).map((s) => s.name));
    const out = new Set<string>();
    for (const rule of Object.values(draft.statuses)) if (rule.kind === "agent" && rule.skill && !have.has(rule.skill)) out.add(rule.skill);
    return out;
  }, [view, draft]);

  if (!loaded || !settings.issuesEnabled) return null;
  if (missing) {
    return (
      <div className="flex-1 p-4">
        <Button variant="ghost" size="sm" onClick={() => router.push("/settings/workflows")}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          Workflows
        </Button>
        <p className="mt-8 text-center text-sm text-muted-foreground">Reusable workflow not found.</p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== saved;
  const empty = Object.keys(draft.statuses).length === 0;
  const usedBy = view.usedBy;
  const data: StatusEditorData = { statuses, skills: view.skills, providers, mcpServers, notifyTargets };

  function setRule(status: string, rule: WorkflowStatusRule | undefined) {
    setDraft((d) => {
      const next = { ...d.statuses };
      if (rule) next[status] = rule;
      else delete next[status];
      return { ...d, statuses: next };
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/reusable-workflows/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, replace: true }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error || "Could not save the workflow");
      else take(body as View);
    } catch {
      setError("Could not reach Cockpit");
    }
    setSaving(false);
  }

  async function remove() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/reusable-workflows/${id}`, { method: "DELETE" });
      if (res.ok) return router.push("/settings/workflows");
      setError((await res.json().catch(() => ({}))).error || "Could not remove the workflow");
    } catch {
      setError("Could not reach Cockpit");
    }
    setConfirmDelete(false);
    setSaving(false);
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-28">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => router.push("/settings/workflows")}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            Workflows
          </Button>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
            disabled={usedBy.length > 0}
            title={usedBy.length > 0 ? "Used by a project, so it cannot be removed" : "Remove this workflow"}
            data-testid="reusable-workflow-remove"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>

        <header className="space-y-2">
          <label className="block">
            <span className="sr-only">Name</span>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="border-0 px-0 text-xl font-semibold shadow-none focus-visible:ring-0"
              data-testid="reusable-workflow-name"
            />
          </label>
          <p className="text-sm text-muted-foreground">
            One definition, selected by several projects.{" "}
            {usedBy.length === 0
              ? "No project uses it yet."
              : `Used by ${usedBy.map((p) => p.name).join(", ")}. A status you add here is added to each of their boards.`}
          </p>
        </header>

        <section className="divide-y rounded-lg border bg-card">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Run this workflow</div>
              <p className="text-xs text-muted-foreground">Off: no project using it starts an agent. Runs already going finish.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={draft.enabled}
              aria-label="Run this workflow"
              onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
              data-testid="reusable-workflow-enabled"
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${draft.enabled ? "bg-primary" : "bg-muted"}`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg transition-transform ${draft.enabled ? "translate-x-4" : "translate-x-0"}`}
              />
            </button>
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Issues worked at once</div>
              <p className="text-xs text-muted-foreground">
                In each project using this workflow. The rest wait their turn, most urgent first.
              </p>
            </div>
            <CountField
              className="w-16 text-center"
              label="Issues worked at once"
              value={draft.maxParallel}
              min={1}
              max={50}
              testId="reusable-workflow-max-parallel"
              onCommit={(maxParallel) => setDraft({ ...draft, maxParallel })}
            />
          </div>
        </section>

        {usedBy.some((p) => p.problems.length > 0) && (
          <section
            className="space-y-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-xs"
            data-testid="reusable-workflow-problems"
          >
            <p className="font-medium">Some projects cannot start an agent yet:</p>
            {usedBy.map((p) =>
              p.problems.map((problem) => (
                <p key={`${p.id}-${problem}`} className="text-muted-foreground">
                  <span className="font-medium text-foreground">{p.name}:</span> {problem}
                </p>
              )),
            )}
          </section>
        )}

        <section className="space-y-3">
          <h2 className="text-sm font-semibold">What happens at each status</h2>
          {empty && (
            <div className="rounded-lg border border-dashed p-4" data-testid="reusable-workflow-empty">
              <p className="text-sm font-medium">Nothing happens at any status yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Press a status to say what happens to an issue there: it queues for an agent, an agent runs a skill on it, or it waits for
                you.
              </p>
              {others.length > 0 && (
                <select
                  aria-label="Copy from a project"
                  data-testid="reusable-workflow-copy"
                  value=""
                  onChange={(e) => {
                    const from = others.find((p) => p.id === e.target.value);
                    if (from?.workflow) setDraft({ ...draft, statuses: from.workflow.statuses });
                  }}
                  className="mt-3 rounded-md border bg-background px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Copy from a project</option>
                  {others.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          <StatusPath rows={rows} rules={draft.statuses} providers={providers} missingSkills={missingSkills} onOpen={setEditing} />
        </section>
      </div>

      {(dirty || error) && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <div className="mx-auto flex max-w-2xl flex-wrap items-center gap-3">
            <p
              className={`min-w-0 flex-1 text-sm ${error ? "text-destructive" : "text-muted-foreground"}`}
              data-testid="reusable-workflow-save-message"
            >
              {error ?? "Unsaved changes"}
            </p>
            <Button variant="outline" size="sm" disabled={saving || !dirty} onClick={() => setDraft(JSON.parse(saved) as Draft)}>
              Discard
            </Button>
            <Button size="sm" disabled={saving || !dirty} onClick={save} data-testid="reusable-workflow-save">
              {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </div>
      )}

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        label={editing ? `Status: ${editing}` : "Status"}
        testId="status-sheet"
        className="h-[92dvh] max-h-[92dvh] sm:h-auto sm:max-h-[88dvh] sm:w-[34rem]"
      >
        {editing !== null && (
          <StatusEditor
            status={editing}
            rule={Object.hasOwn(draft.statuses, editing) ? draft.statuses[editing] : undefined}
            rules={draft.statuses}
            data={data}
            onChange={(rule) => setRule(editing, rule)}
            onDone={() => setEditing(null)}
          />
        )}
      </Sheet>

      <Dialog open={confirmDelete} onOpenChange={(v) => !saving && setConfirmDelete(v)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove {view.workflow.name}?</DialogTitle>
          </DialogHeader>
          {usedBy.length > 0 ? (
            <p className="mb-4 mt-2 text-sm text-muted-foreground">
              It is used by {usedBy.map((p) => p.name).join(", ")}. Switch those projects to their own workflow first.
            </p>
          ) : (
            <p className="mb-4 mt-2 text-sm text-muted-foreground">
              Projects will not be able to select it again. No project uses it now, so no issue is affected.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={remove}
              disabled={saving || usedBy.length > 0}
              data-testid="reusable-workflow-remove-confirm"
            >
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
