"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type ClaudeMdFile, useClaudeMd } from "@/hooks/use-claude-md";
import { pathBasename } from "@/lib/path";

const SCOPE_DESCRIPTION: Record<ClaudeMdFile["scope"], string> = {
  user: "Applies to all projects",
  project: "Visible, committed to repo",
  "project-hidden": "Hidden, not committed",
};

function scopeLabel(scope: ClaudeMdFile["scope"]): string {
  switch (scope) {
    case "user":
      return "~/.claude/CLAUDE.md";
    case "project":
      return "CLAUDE.md";
    case "project-hidden":
      return ".claude/CLAUDE.md";
  }
}

export default function ClaudeMdPage() {
  usePageHeader("CLAUDE.md");

  const { files, cwds, loading } = useClaudeMd();
  const router = useRouter();
  const [newDialog, setNewDialog] = useState(false);

  function handleClick(file: ClaudeMdFile) {
    const params = new URLSearchParams({ scope: file.scope });
    if (file.cwd) params.set("cwd", file.cwd);
    router.push(`/claude-md/edit?${params}`);
  }

  function handleNew(scope: "project" | "project-hidden", cwd: string) {
    setNewDialog(false);
    const params = new URLSearchParams({ scope, cwd });
    router.push(`/claude-md/edit?${params}`);
  }

  const globalFile = files.find((f) => f.scope === "user");

  // Group project files by cwd
  const projectFiles = files.filter((f) => f.scope !== "user");
  const byCwd = new Map<string, ClaudeMdFile[]>();
  for (const f of projectFiles) {
    if (!f.cwd) continue;
    const list = byCwd.get(f.cwd) || [];
    list.push(f);
    byCwd.set(f.cwd, list);
  }

  // cwds that have at least one existing file
  const cwdsWithFiles = new Set<string>();
  for (const f of projectFiles) {
    if (f.cwd && f.exists) cwdsWithFiles.add(f.cwd);
  }

  // cwds available for "new" that don't have both files yet
  const cwdsForNew = cwds.filter((cwd) => {
    const group = byCwd.get(cwd) || [];
    const existingCount = group.filter((f) => f.exists).length;
    return existingCount < 2;
  });

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div />
        {cwdsForNew.length > 0 && (
          <Button size="sm" onClick={() => setNewDialog(true)}>
            <Plus className="h-4 w-4 mr-1" />
            New
          </Button>
        )}
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading...</p>}

      {!loading && globalFile && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Global</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <FileRow file={globalFile} onClick={() => handleClick(globalFile)} />
          </CardContent>
        </Card>
      )}

      {!loading &&
        Array.from(byCwd.entries()).map(([cwd, group]) => {
          const existing = group.filter((f) => f.exists);
          if (existing.length === 0) return null;
          const dirName = pathBasename(cwd) || cwd;
          return (
            <Card key={cwd}>
              <CardHeader>
                <CardTitle className="text-base">{dirName}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {existing.map((file) => (
                  <FileRow key={file.scope} file={file} onClick={() => handleClick(file)} />
                ))}
              </CardContent>
            </Card>
          );
        })}

      <NewFileDialog open={newDialog} onOpenChange={setNewDialog} cwds={cwdsForNew} byCwd={byCwd} onSelect={handleNew} />
    </div>
  );
}

function FileRow({ file, onClick }: { file: ClaudeMdFile; onClick: () => void }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded px-2 py-2 hover:bg-muted transition-colors text-left"
      onClick={onClick}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-sm">{scopeLabel(file.scope)}</span>
          <Badge variant="secondary" className="text-[10px]">
            {file.scope === "user" ? "Global" : "Project"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{SCOPE_DESCRIPTION[file.scope]}</p>
      </div>
    </button>
  );
}

function NewFileDialog({
  open,
  onOpenChange,
  cwds,
  byCwd,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cwds: string[];
  byCwd: Map<string, ClaudeMdFile[]>;
  onSelect: (scope: "project" | "project-hidden", cwd: string) => void;
}) {
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);

  function missingScopes(cwd: string): ("project" | "project-hidden")[] {
    const group = byCwd.get(cwd) || [];
    const scopes: ("project" | "project-hidden")[] = [];
    if (!group.some((f) => f.scope === "project" && f.exists)) scopes.push("project");
    if (!group.some((f) => f.scope === "project-hidden" && f.exists)) scopes.push("project-hidden");
    return scopes;
  }

  function handleCwdClick(cwd: string) {
    const missing = missingScopes(cwd);
    if (missing.length === 1) {
      onSelect(missing[0], cwd);
    } else {
      setSelectedCwd(cwd);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setSelectedCwd(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{selectedCwd ? "Choose type" : "Choose project"}</DialogTitle>
        </DialogHeader>

        {!selectedCwd && (
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {cwds.map((cwd) => {
              const dirName = pathBasename(cwd) || cwd;
              return (
                <button
                  key={cwd}
                  className="flex w-full items-center rounded px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
                  onClick={() => handleCwdClick(cwd)}
                >
                  <span className="font-mono">{dirName}</span>
                  <span className="ml-2 text-xs text-muted-foreground truncate">{cwd}</span>
                </button>
              );
            })}
          </div>
        )}

        {selectedCwd && (
          <div className="flex gap-2">
            {missingScopes(selectedCwd).map((scope) => (
              <Button key={scope} variant="outline" className="flex-1" onClick={() => onSelect(scope, selectedCwd)}>
                {scope === "project" ? "CLAUDE.md" : ".claude/CLAUDE.md"}
              </Button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
