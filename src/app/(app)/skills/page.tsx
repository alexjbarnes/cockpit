"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePageHeader } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSkills } from "@/hooks/use-skills";
import { Plus, Trash2 } from "lucide-react";

export default function SkillsPage() {
  usePageHeader("Skills");

  const cwd = typeof localStorage !== "undefined"
    ? localStorage.getItem("cockpit-agents-cwd") || undefined
    : undefined;

  const { skills, loading, deleteSkill } = useSkills(cwd);
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState<{ name: string; scope: "user" | "project" } | null>(null);
  const [scopeDialog, setScopeDialog] = useState(false);

  const globalSkills = skills.filter((s) => s.scope === "user");
  const projectSkills = skills.filter((s) => s.scope === "project");

  function handleNew(scope: "user" | "project") {
    setScopeDialog(false);
    const params = new URLSearchParams({ scope });
    if (scope === "project" && cwd) params.set("cwd", cwd);
    router.push(`/skills/new?${params}`);
  }

  function handleClick(name: string, scope: "user" | "project") {
    const params = new URLSearchParams({ scope });
    if (scope === "project" && cwd) params.set("cwd", cwd);
    router.push(`/skills/${encodeURIComponent(name)}?${params}`);
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    await deleteSkill(confirmDelete.name, confirmDelete.scope);
    setConfirmDelete(null);
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div />
        <Button size="sm" onClick={() => setScopeDialog(true)}>
          <Plus className="h-4 w-4 mr-1" />
          New Skill
        </Button>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading skills...</p>}

      {!loading && skills.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No custom skills found. Create one to get started.
        </p>
      )}

      {globalSkills.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Global</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {globalSkills.map((skill) => (
              <SkillRow
                key={skill.name}
                name={skill.name}
                scope="user"
                description={skill.description}
                onClick={() => handleClick(skill.name, "user")}
                onDelete={() => setConfirmDelete({ name: skill.name, scope: "user" })}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {projectSkills.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Project</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {projectSkills.map((skill) => (
              <SkillRow
                key={skill.name}
                name={skill.name}
                scope="project"
                description={skill.description}
                onClick={() => handleClick(skill.name, "project")}
                onDelete={() => setConfirmDelete({ name: skill.name, scope: "project" })}
              />
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={scopeDialog} onOpenChange={setScopeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Skill</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">
            Where should this skill be saved?
          </p>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => handleNew("user")}>
              Global
            </Button>
            <Button variant="outline" className="flex-1" onClick={() => handleNew("project")} disabled={!cwd}>
              Project
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Skill</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">
            Delete <span className="font-mono font-bold">{confirmDelete?.name}</span>? This cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Delete</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SkillRow({
  name,
  scope,
  description,
  onClick,
  onDelete,
}: {
  name: string;
  scope: "user" | "project";
  description?: string;
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded px-2 py-2 hover:bg-muted transition-colors">
      <button type="button" className="flex-1 text-left min-w-0" onClick={onClick}>
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-sm">{name}</span>
          <Badge variant="secondary" className="text-[10px]">
            {scope === "user" ? "Global" : "Project"}
          </Badge>
        </div>
        {description && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{description}</p>
        )}
      </button>
      <button
        type="button"
        className="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
