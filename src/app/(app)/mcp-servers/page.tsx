"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePageHeader } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DirectoryPicker } from "@/components/directory-picker";
import { useMcpServers } from "@/hooks/use-mcp-servers";
import { Plus, Trash2 } from "lucide-react";

export default function McpServersPage() {
  usePageHeader("MCP Servers");

  const cwd = typeof localStorage !== "undefined"
    ? localStorage.getItem("aperture-agents-cwd") || undefined
    : undefined;

  const { servers, loading, deleteServer } = useMcpServers(cwd);
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState<{ name: string; scope: "user" | "project" } | null>(null);
  const [scopeDialog, setScopeDialog] = useState(false);
  const [pickingDir, setPickingDir] = useState(false);

  const globalServers = servers.filter((s) => s.scope === "user");
  const projectServers = servers.filter((s) => s.scope === "project");

  function handleNew(scope: "user" | "project", projectCwd?: string) {
    setScopeDialog(false);
    setPickingDir(false);
    const params = new URLSearchParams({ scope });
    if (scope === "project" && projectCwd) params.set("cwd", projectCwd);
    router.push(`/mcp-servers/new?${params}`);
  }

  function handleClick(name: string, scope: "user" | "project") {
    const params = new URLSearchParams({ scope });
    if (scope === "project" && cwd) params.set("cwd", cwd);
    router.push(`/mcp-servers/${encodeURIComponent(name)}?${params}`);
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    await deleteServer(confirmDelete.name, confirmDelete.scope);
    setConfirmDelete(null);
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div />
        <Button size="sm" onClick={() => setScopeDialog(true)}>
          <Plus className="h-4 w-4 mr-1" />
          New Server
        </Button>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading servers...</p>}

      {!loading && servers.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No MCP servers configured. Add one to get started.
        </p>
      )}

      {globalServers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Global</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {globalServers.map((server) => (
              <ServerRow
                key={server.name}
                name={server.name}
                scope="user"
                type={server.type}
                detail={server.command || server.url}
                onClick={() => handleClick(server.name, "user")}
                onDelete={() => setConfirmDelete({ name: server.name, scope: "user" })}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {projectServers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Project</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {projectServers.map((server) => (
              <ServerRow
                key={server.name}
                name={server.name}
                scope="project"
                type={server.type}
                detail={server.command || server.url}
                onClick={() => handleClick(server.name, "project")}
                onDelete={() => setConfirmDelete({ name: server.name, scope: "project" })}
              />
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={scopeDialog} onOpenChange={(open) => { setScopeDialog(open); if (!open) setPickingDir(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New MCP Server</DialogTitle>
          </DialogHeader>
          {pickingDir ? (
            <DirectoryPicker
              onSelect={(dir) => handleNew("project", dir)}
              onCancel={() => setPickingDir(false)}
            />
          ) : (
            <>
              <p className="text-sm text-muted-foreground mb-4">
                Where should this server be saved?
              </p>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => handleNew("user")}>
                  Global
                </Button>
                <Button variant="outline" className="flex-1" onClick={() => setPickingDir(true)}>
                  Project
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Server</DialogTitle>
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

function ServerRow({
  name,
  scope,
  type,
  detail,
  onClick,
  onDelete,
}: {
  name: string;
  scope: "user" | "project";
  type: string;
  detail?: string;
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded px-2 py-2 hover:bg-muted transition-colors">
      <button type="button" className="flex-1 text-left min-w-0" onClick={onClick}>
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-sm">{name}</span>
          <Badge variant="secondary" className="text-[10px]">
            {type}
          </Badge>
        </div>
        {detail && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{detail}</p>
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
