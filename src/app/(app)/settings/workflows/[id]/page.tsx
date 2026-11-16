"use client";

import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet } from "@/components/ui/sheet";
import { CountField } from "@/components/workflows/count-field";
import type { RepoSkillView } from "@/components/workflows/skill-select";
import { StatusEditor, type StatusEditorData } from "@/components/workflows/status-editor";
import { StatusPath } from "@/components/workflows/status-path";
import { useSettings } from "@/hooks/use-settings";
import { statusRows } from "@/lib/workflow-display";
import type { Provider, Workflow, WorkflowStatusRule } from "@/types";

/** What the page edits: the parts of a workflow a person sets. */
interface Draft {
  enabled: boolean;
  maxParallel: number;
  statuses: Record<string, WorkflowStatusRule>;
}

interface View {
  project: { id: string; name: string; prefix: string; repoPath?: string; baseBranch?: string };
  workflow: Workflow | null;
  statuses: string[];
  skills: RepoSkillView[];
  problems: string[];
}

interface OtherProject {
  id: string;
  name: string;
  workflow: Workflow | null;
}

const BLANK: Draft = { enabled: true, maxParallel: 2, statuses: {} };

function draftOf(workflow: Workflow | null): Draft {
  return workflow ? { enabled: workflow.enabled, maxParallel: workflow.maxParallel, statuses: workflow.statuses } : BLANK;
}

/**
 * One project's workflow: its statuses in board order, and what happens to an
 * issue at each. The page is addressed by the project's id, since a workflow
 * belongs to one project.
 */
export default function WorkflowEditPage() {
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
    fetch(`/api/projects/${id}/workflow`)
      .then(async (res) => {
        if (!res.ok) return setMissing(true);
        take((await res.json()) as View);
      })
      .catch(() => setMissing(true));
    fetch("/api/workflows")
      .then((r) => r.json())
      .then((d: { projects?: OtherProject[] }) => setOthers((d.projects ?? []).filter((p) => p.id !== id && p.workflow)))
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

  // The statuses to choose from: the board's own, and any the workflow
  // already names (one typed in as new is added to the board on save).
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
    // With no repo to read, every skill would read as missing: the page says that once instead.
    if (!view?.project.repoPath) return out;
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
        <p className="mt-8 text-center text-sm text-muted-foreground">Project not found.</p>
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

  const { project } = view;
  const dirty = JSON.stringify(draft) !== saved;
  const empty = Object.keys(draft.statuses).length === 0;
  const noRepo = project.repoPath
    ? undefined
    : `${project.name} has no repo path, so there are no skills to choose from. Set one in Settings, Projects.`;
  const data: StatusEditorData = { statuses, skills: view.skills, noRepo, providers, mcpServers, notifyTargets };

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
      const res = await fetch(`/api/projects/${id}/workflow`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // What is on the page is the whole workflow: a status cleared here is cleared.
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
      const res = await fetch(`/api/projects/${id}/workflow`, { method: "DELETE" });
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
          {view.workflow && (
            <Button
              variant="ghost"
              size="icon"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
              title="Remove this workflow"
              data-testid="workflow-remove"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>

        <header className="space-y-1">
          <h1 className="text-xl font-semibold" data-testid="workflow-title">
            {project.name}'s workflow
          </h1>
          <p className="text-sm text-muted-foreground">
            What happens to {project.name}'s issues at each status.{" "}
            {project.repoPath ? (
              <>
                Agents run skills from <span className="font-mono text-xs">{project.repoPath}</span>
              </>
            ) : (
              "It has no repo path yet, so there are no skills for an agent to run."
            )}
          </p>
        </header>

        <section className="divide-y rounded-lg border bg-card">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Run this workflow</div>
              <p className="text-xs text-muted-foreground">Off: this is only a description, and no agent starts.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={draft.enabled}
              aria-label="Run this workflow"
              onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
              data-testid="workflow-enabled"
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
              <p className="text-xs text-muted-foreground">In this project. The rest wait their turn, most urgent first.</p>
            </div>
            <CountField
              className="w-16 text-center"
              label="Issues worked at once"
              value={draft.maxParallel}
              min={1}
              max={50}
              testId="workflow-max-parallel"
              onCommit={(maxParallel) => setDraft({ ...draft, maxParallel })}
            />
          </div>
        </section>

        {/* The board's statuses, in board order, and what happens at each. */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">What happens at each status</h2>
          {empty && (
            <div className="rounded-lg border border-dashed p-4" data-testid="workflow-empty">
              <p className="text-sm font-medium">Nothing happens at any status yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Press a status to say what happens to an issue there: it queues for an agent, an agent runs one of this repo's skills on it,
                or it waits for you. Or ask an agent working in this repo to write the skills and set this up.
              </p>
              {others.length > 0 && (
                <select
                  aria-label="Copy from another project"
                  data-testid="workflow-copy"
                  value=""
                  onChange={(e) => {
                    const from = others.find((p) => p.id === e.target.value);
                    // Brought onto the page as unsaved changes, so it is read before it runs.
                    if (from?.workflow) setDraft({ ...draft, statuses: from.workflow.statuses });
                  }}
                  className="mt-3 rounded-md border bg-background px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Copy from another project</option>
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

      {/* The save bar stays in reach however long the list is. */}
      {(dirty || error) && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <div className="mx-auto flex max-w-2xl flex-wrap items-center gap-3">
            <p
              className={`min-w-0 flex-1 text-sm ${error ? "text-destructive" : "text-muted-foreground"}`}
              data-testid="workflow-save-message"
            >
              {error ?? "Unsaved changes"}
            </p>
            <Button variant="outline" size="sm" disabled={saving || !dirty} onClick={() => setDraft(JSON.parse(saved) as Draft)}>
              Discard
            </Button>
            <Button size="sm" disabled={saving || !dirty} onClick={save} data-testid="workflow-save">
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
            <DialogTitle>Remove {project.name}'s workflow?</DialogTitle>
          </DialogHeader>
          <p className="mb-4 mt-2 text-sm text-muted-foreground">
            Agents working on its issues are stopped. The issues, the project's statuses and the run history are not touched.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={remove} disabled={saving} data-testid="workflow-remove-confirm">
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
