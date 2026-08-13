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
import type { Issue, Project } from "@/types";

interface FormState {
  id: string;
  name: string;
  prefix: string;
  description: string;
  repoPath: string;
}

const emptyForm = (): FormState => ({ id: "", name: "", prefix: "", description: "", repoPath: "" });

function projectToForm(p: Project): FormState {
  return { id: p.id, name: p.name, prefix: p.prefix, description: p.description || "", repoPath: p.repoPath || "" };
}

export default function ProjectsSettingsPage() {
  usePageHeader("Projects", { hideActions: true });
  const router = useRouter();
  const { settings, loaded: settingsLoaded } = useSettings();

  const [projects, setProjects] = useState<Project[]>([]);
  const [issueCounts, setIssueCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [editForm, setEditForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchAll = useCallback(async () => {
    const [projectsRes, issuesRes] = await Promise.all([fetch("/api/projects"), fetch("/api/issues")]);
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
    };
    try {
      const res = await fetch(editForm.id ? `/api/projects/${editForm.id}` : "/api/projects", {
        method: editForm.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
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
                  </div>
                  {p.repoPath && <div className="text-xs text-muted-foreground truncate font-mono mt-0.5">{p.repoPath}</div>}
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => startEdit(p)}>
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
                <Button size="sm" onClick={handleSave} disabled={saving || !editForm.name.trim() || !editForm.prefix.trim()}>
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
