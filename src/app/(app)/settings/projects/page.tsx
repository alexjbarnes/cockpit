"use client";

import { ArrowLeft, Folder, FolderOpen, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { DirectoryPicker } from "@/components/directory-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSettings } from "@/hooks/use-settings";
import { ISSUE_STATUSES, LABEL_COLORS, statusColor } from "@/lib/issue-display";
import { cn } from "@/lib/utils";
import type { CustomStatus, Issue, Project, WorkflowStatusRule } from "@/types";

interface FormState {
  id: string;
  name: string;
  prefix: string;
  description: string;
  repoPath: string;
  disabledStatuses: string[];
  customStatuses: CustomStatus[];
  baseBranch: string;
  /** A reusable workflow id, or "" for the project's own workflow. */
  reusableWorkflowId: string;
}

const emptyForm = (): FormState => ({
  id: "",
  name: "",
  prefix: "",
  description: "",
  repoPath: "",
  disabledStatuses: [],
  customStatuses: [],
  baseBranch: "",
  reusableWorkflowId: "",
});

function projectToForm(p: Project): FormState {
  return {
    id: p.id,
    name: p.name,
    prefix: p.prefix,
    description: p.description || "",
    repoPath: p.repoPath || "",
    disabledStatuses: p.disabledStatuses ?? [],
    customStatuses: p.customStatuses ?? [],
    baseBranch: p.baseBranch ?? "",
    reusableWorkflowId: p.reusableWorkflowId ?? "",
  };
}

interface ReusableChoice {
  id: string;
  name: string;
  statuses: Record<string, WorkflowStatusRule>;
}

/** Every status a workflow's rules name, for locking those rows in the editor. */
function statusesNamedBy(rules: Record<string, WorkflowStatusRule>): Set<string> {
  const names = new Set<string>();
  for (const [status, rule] of Object.entries(rules)) {
    names.add(status);
    if (rule.kind === "queue") names.add(rule.to);
    else if (rule.kind === "agent") for (const target of rule.next) names.add(target);
    else for (const choice of rule.next) names.add(choice.status);
  }
  return names;
}

/** Built-in enable/disable toggles + custom status add/remove for the project
 *  edit dialog. Purely edits the form; the page persists it on Save. */
function StatusEditor({
  form,
  setForm,
  locked,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  /** Statuses the selected reusable workflow names; they cannot leave the board. */
  locked: ReadonlySet<string>;
}) {
  const [newName, setNewName] = useState("");
  const disabled = new Set(form.disabledStatuses);
  const takenLower = new Set([
    ...(ISSUE_STATUSES as readonly string[]).map((s) => s.toLowerCase()),
    ...form.customStatuses.map((s) => s.name.toLowerCase()),
  ]);
  const trimmed = newName.trim();
  const canAdd = trimmed !== "" && !takenLower.has(trimmed.toLowerCase());

  function toggleBuiltin(name: string): void {
    const next = new Set(disabled);
    next.has(name) ? next.delete(name) : next.add(name);
    setForm({ ...form, disabledStatuses: [...next] });
  }
  function addCustom(): void {
    if (!canAdd) return;
    setForm({ ...form, customStatuses: [...form.customStatuses, { name: trimmed }] });
    setNewName("");
  }
  function removeCustom(name: string): void {
    setForm({ ...form, customStatuses: form.customStatuses.filter((s) => s.name !== name) });
  }
  function setColor(name: string, color: string): void {
    setForm({ ...form, customStatuses: form.customStatuses.map((s) => (s.name === name ? { ...s, color } : s)) });
  }
  /** Whether the status counts as active on the issues page's Active filter. */
  function setActive(name: string, active: boolean): void {
    setForm({
      ...form,
      customStatuses: form.customStatuses.map((s) => (s.name === name ? { ...s, active: active ? undefined : false } : s)),
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <span className="text-sm font-medium">Statuses</span>
        <p className="text-xs text-muted-foreground">
          Turn off built-in statuses this project doesn't use, or add your own board columns. Built-in statuses drive the automation, so
          they can't be renamed or removed.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {ISSUE_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => toggleBuiltin(s)}
            disabled={locked.has(s)}
            title={locked.has(s) ? "The selected reusable workflow uses this status" : undefined}
            className={cn(
              "flex items-center gap-2 rounded border px-2 py-1 text-xs transition-colors",
              locked.has(s) ? "cursor-not-allowed opacity-60" : disabled.has(s) ? "opacity-40 hover:opacity-70" : "hover:bg-muted/50",
            )}
          >
            <span className={cn("h-2 w-2 shrink-0 rounded-full", statusColor(s))} />
            <span className="truncate">{s}</span>
            <span className="ml-auto text-[10px] text-muted-foreground">{disabled.has(s) ? "off" : "on"}</span>
          </button>
        ))}
      </div>

      {form.customStatuses.length > 0 && (
        <div className="space-y-1.5">
          {form.customStatuses.map((c) => (
            // The palette sits under the name rather than beside it: fourteen
            // swatches are wider than a phone's dialog, and beside the name they
            // squeezed it to nothing, leaving a row of dots and a bin.
            <div key={c.name} className="space-y-1.5 rounded border px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "h-2.5 w-2.5 shrink-0 rounded-full",
                    statusColor(c.name, { customStatuses: form.customStatuses } as Project),
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{c.name}</span>
                <button
                  type="button"
                  aria-pressed={c.active !== false}
                  data-testid={`custom-status-active-${c.name}`}
                  title="Whether issues at this status count as active on the issues page"
                  onClick={() => setActive(c.name, c.active === false)}
                  className={cn(
                    "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                    c.active === false ? "text-muted-foreground" : "bg-secondary text-secondary-foreground",
                  )}
                >
                  {c.active === false ? "Not active" : "Active"}
                </button>
                <button
                  type="button"
                  onClick={() => removeCustom(c.name)}
                  disabled={locked.has(c.name)}
                  title={locked.has(c.name) ? "The selected reusable workflow uses this status" : "Remove this status"}
                  className="shrink-0 text-muted-foreground hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex flex-wrap gap-1">
                {LABEL_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`colour ${color}`}
                    aria-pressed={c.color === color}
                    data-testid={`custom-status-colour-${c.name}-${color}`}
                    onClick={() => setColor(c.name, color)}
                    className={cn("h-3.5 w-3.5 rounded-full", color, c.color === color ? "ring-2 ring-offset-1 ring-foreground" : "")}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
          placeholder="Add a custom status, e.g. Blocked"
          className="h-8 text-xs"
        />
        <Button type="button" size="sm" variant="outline" onClick={addCustom} disabled={!canAdd}>
          Add
        </Button>
      </div>
      {trimmed !== "" && !canAdd && <p className="text-xs text-destructive">That name is already a status.</p>}
      {form.customStatuses.length > 0 && (
        <p className="text-xs text-muted-foreground">
          A custom status is added to the list as you type its name, and its colour and Active tag are set here. All of it is stored when
          the project is saved, with the Save button below. A status tagged Not active files with the backlog on the issues page.
        </p>
      )}
    </div>
  );
}

export default function ProjectsSettingsPage() {
  usePageHeader("Projects", { hideActions: true });
  const router = useRouter();
  const { settings, loaded: settingsLoaded } = useSettings();

  const [projects, setProjects] = useState<Project[]>([]);
  const [reusable, setReusable] = useState<ReusableChoice[]>([]);
  const [issueCounts, setIssueCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [editForm, setEditForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchAll = useCallback(async () => {
    const [projectsRes, issuesRes, workflowsRes] = await Promise.all([
      fetch("/api/projects"),
      fetch("/api/issues"),
      fetch("/api/workflows"),
    ]);
    if (projectsRes.ok) {
      const data = await projectsRes.json();
      setProjects(data.projects || []);
    }
    if (issuesRes.ok) {
      const data = await issuesRes.json();
      const counts = new Map<string, number>();
      for (const issue of (data.issues || []) as Issue[]) {
        counts.set(issue.projectId, (counts.get(issue.projectId) || 0) + 1);
      }
      setIssueCounts(counts);
    }
    if (workflowsRes.ok) {
      const data = (await workflowsRes.json()) as { reusable?: ReusableChoice[] };
      setReusable(data.reusable ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // See issues/page.tsx's identical guard for why this waits on settingsLoaded.
  useEffect(() => {
    if (settingsLoaded && !settings.issuesEnabled) router.replace("/");
  }, [settingsLoaded, settings.issuesEnabled, router]);

  function startCreate() {
    setEditForm(emptyForm());
    setFormError(null);
    setBrowsing(false);
  }

  function startEdit(p: Project) {
    setEditForm(projectToForm(p));
    setFormError(null);
    setBrowsing(false);
  }

  async function handleSave() {
    if (!editForm?.name.trim() || !editForm.prefix.trim()) return;
    setSaving(true);
    setFormError(null);
    const body = {
      name: editForm.name.trim(),
      prefix: editForm.prefix.trim(),
      description: editForm.description.trim() || undefined,
      repoPath: editForm.repoPath.trim() || undefined,
      disabledStatuses: editForm.disabledStatuses,
      customStatuses: editForm.customStatuses,
    };
    // The base branch and the workflow source are set by an update, so a new
    // project is created first and given them second.
    const flow = { baseBranch: editForm.baseBranch.trim(), reusableWorkflowId: editForm.reusableWorkflowId || null };
    try {
      let res = await fetch(editForm.id ? `/api/projects/${editForm.id}` : "/api/projects", {
        method: editForm.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editForm.id ? { ...body, ...flow } : body),
      });
      let data = await res.json();
      if (res.ok && !editForm.id && (flow.baseBranch || flow.reusableWorkflowId)) {
        const created = data.project as Project;
        setEditForm({ ...editForm, id: created.id });
        res = await fetch(`/api/projects/${created.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(flow),
        });
        data = await res.json();
      }
      if (!res.ok) {
        setFormError(data.error || "Failed to save project");
        return;
      }
      setEditForm(null);
      fetchAll();
    } catch {
      setFormError("Failed to connect");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await fetch(`/api/projects/${confirmDelete.id}`, { method: "DELETE" });
      setConfirmDelete(null);
      fetchAll();
    } finally {
      setDeleting(false);
    }
  }

  const deleteCount = confirmDelete ? issueCounts.get(confirmDelete.id) || 0 : 0;
  const selectedReusable = editForm?.reusableWorkflowId
    ? reusable.find((workflow) => workflow.id === editForm.reusableWorkflowId)
    : undefined;
  const lockedStatuses = statusesNamedBy(selectedReusable?.statuses ?? {});

  if (!settingsLoaded || !settings.issuesEnabled) return null;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <Button variant="ghost" size="sm" onClick={() => router.push("/settings")}>
        <ArrowLeft className="h-4 w-4 mr-1" />
        Settings
      </Button>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Projects</CardTitle>
            {!editForm && (
              <Button size="sm" variant="outline" onClick={startCreate}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {loading && <p className="text-sm text-muted-foreground">Loading...</p>}

          {!loading && projects.length === 0 && !editForm && (
            <div className="flex flex-col items-center py-8 text-center">
              <Folder className="h-10 w-10 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground">No projects yet.</p>
              <p className="text-xs text-muted-foreground mt-1">Create one to start tracking issues against a repo.</p>
            </div>
          )}

          {!editForm &&
            projects.map((p) => (
              <div key={p.id} className="flex items-center gap-3 py-2.5 border-b last:border-b-0">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium truncate">{p.name}</span>
                    <span className="text-xs font-mono text-muted-foreground">{p.prefix}</span>
                    <span className="text-xs text-muted-foreground">
                      {issueCounts.get(p.id) || 0} issue{(issueCounts.get(p.id) || 0) === 1 ? "" : "s"}
                    </span>
                    {p.reusableWorkflowId && (
                      <span className="text-xs text-muted-foreground">
                        Shared: {reusable.find((workflow) => workflow.id === p.reusableWorkflowId)?.name ?? "missing workflow"}
                      </span>
                    )}
                  </div>
                  {p.repoPath && <div className="text-xs text-muted-foreground truncate font-mono mt-0.5">{p.repoPath}</div>}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  data-testid={`edit-project-${p.id}`}
                  onClick={() => startEdit(p)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                  onClick={() => setConfirmDelete(p)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}

          {editForm && (
            <div className="space-y-3 pt-2">
              <div>
                <label className="text-xs text-muted-foreground">Name</label>
                <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} placeholder="Cockpit" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Prefix</label>
                <Input
                  value={editForm.prefix}
                  onChange={(e) => setEditForm({ ...editForm, prefix: e.target.value })}
                  placeholder="CK"
                  className="font-mono uppercase"
                  maxLength={8}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Drives issue keys ({editForm.prefix.trim() ? `${editForm.prefix.trim().toUpperCase()}-1` : "CK-1"}, ...). Immutable once
                  the project has issues.
                </p>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Description (optional)</label>
                <Input
                  value={editForm.description}
                  onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                  placeholder="What this project is for"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Repo Path (optional)</label>
                <div className="flex gap-2">
                  <Input
                    value={editForm.repoPath}
                    onChange={(e) => setEditForm({ ...editForm, repoPath: e.target.value })}
                    placeholder="/home/user/my-repo"
                    className="flex-1 font-mono"
                  />
                  <Button variant="outline" size="sm" onClick={() => setBrowsing(!browsing)} title="Browse directories">
                    <FolderOpen className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  The repo this project's pipeline jobs run against. Leave empty if this project has no dedicated repo.
                </p>
                {browsing && (
                  <div className="mt-2">
                    <DirectoryPicker
                      onSelect={(p) => {
                        setEditForm({ ...editForm, repoPath: p });
                        setBrowsing(false);
                      }}
                      onCancel={() => setBrowsing(false)}
                    />
                  </div>
                )}
              </div>

              <div className="border-t pt-3">
                <StatusEditor form={editForm} setForm={setEditForm} locked={lockedStatuses} />
              </div>

              <div className="border-t pt-3">
                <label className="text-xs text-muted-foreground" htmlFor="project-workflow">
                  Workflow
                </label>
                <select
                  id="project-workflow"
                  data-testid="project-workflow"
                  value={editForm.reusableWorkflowId}
                  onChange={(e) => setEditForm({ ...editForm, reusableWorkflowId: e.target.value })}
                  className="w-full rounded-md border bg-background px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Its own workflow</option>
                  {reusable.map((workflow) => (
                    <option key={workflow.id} value={workflow.id}>
                      {workflow.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground mt-1">
                  A reusable workflow is shared by several projects. Its statuses are added to this project's board when you save.
                </p>
              </div>

              <div className="border-t pt-3">
                <label className="text-xs text-muted-foreground" htmlFor="project-base-branch">
                  Base branch (optional)
                </label>
                <Input
                  id="project-base-branch"
                  data-testid="project-base-branch"
                  value={editForm.baseBranch}
                  onChange={(e) => setEditForm({ ...editForm, baseBranch: e.target.value })}
                  placeholder="The repo's default branch"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  The branch an issue's work starts from when an agent works on it. What agents do with this project's issues is set in
                  Settings, Workflows.
                </p>
              </div>

              {formError && <p className="text-sm text-destructive">{formError}</p>}

              <div className="flex justify-end gap-2 pt-2 border-t">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditForm(null);
                    setFormError(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={saving || !editForm.name.trim() || !editForm.prefix.trim()}
                  data-testid="project-save"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                  Save
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Project</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">
            Delete <span className="font-medium text-foreground">{confirmDelete?.name}</span>
            {deleteCount > 0 && (
              <>
                {" "}
                and its {deleteCount} issue{deleteCount === 1 ? "" : "s"}
              </>
            )}
            ? This cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
