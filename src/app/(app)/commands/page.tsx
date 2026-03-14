"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePageHeader } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCommands } from "@/hooks/use-commands";
import { Plus, Trash2 } from "lucide-react";

export default function CommandsPage() {
  usePageHeader("Commands", true);

  const cwd = typeof localStorage !== "undefined"
    ? localStorage.getItem("aperture-agents-cwd") || undefined
    : undefined;

  const { commands, loading, deleteCommand } = useCommands(cwd);
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState<{ name: string; scope: "user" | "project" } | null>(null);
  const [scopeDialog, setScopeDialog] = useState(false);

  const globalCommands = commands.filter((c) => c.scope === "user");
  const projectCommands = commands.filter((c) => c.scope === "project");

  function handleNew(scope: "user" | "project") {
    setScopeDialog(false);
    const params = new URLSearchParams({ scope });
    if (scope === "project" && cwd) params.set("cwd", cwd);
    router.push(`/commands/new?${params}`);
  }

  function handleClick(name: string, scope: "user" | "project") {
    const params = new URLSearchParams({ scope });
    if (scope === "project" && cwd) params.set("cwd", cwd);
    router.push(`/commands/${encodeURIComponent(name)}?${params}`);
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    await deleteCommand(confirmDelete.name, confirmDelete.scope);
    setConfirmDelete(null);
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div />
        <Button size="sm" onClick={() => setScopeDialog(true)}>
          <Plus className="h-4 w-4 mr-1" />
          New Command
        </Button>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading commands...</p>}

      {!loading && commands.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No custom commands found. Create one to get started.
        </p>
      )}

      {globalCommands.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Global</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {globalCommands.map((cmd) => (
              <CommandRow
                key={cmd.name}
                name={cmd.name}
                scope="user"
                description={cmd.description}
                onClick={() => handleClick(cmd.name, "user")}
                onDelete={() => setConfirmDelete({ name: cmd.name, scope: "user" })}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {projectCommands.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Project</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {projectCommands.map((cmd) => (
              <CommandRow
                key={cmd.name}
                name={cmd.name}
                scope="project"
                description={cmd.description}
                onClick={() => handleClick(cmd.name, "project")}
                onDelete={() => setConfirmDelete({ name: cmd.name, scope: "project" })}
              />
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={scopeDialog} onOpenChange={setScopeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Command</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">
            Where should this command be saved?
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
            <DialogTitle>Delete Command</DialogTitle>
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

function CommandRow({
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
