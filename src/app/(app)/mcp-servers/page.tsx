"use client";

import { ArrowLeft, ChevronRight, Loader2, Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { DirectoryPicker } from "@/components/directory-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type McpServerConfig, useMcpServers } from "@/hooks/use-mcp-servers";

export default function McpServersPage() {
  usePageHeader("MCP Servers", { hideActions: true });

  const searchParams = useSearchParams();
  const router = useRouter();
  const mcpName = searchParams.get("mcp");
  const mcpScope = (searchParams.get("scope") || "user") as "user" | "project";

  const cwd = typeof localStorage !== "undefined" ? localStorage.getItem("cockpit-agents-cwd") || undefined : undefined;
  const { servers, loading, getServer, deleteServer } = useMcpServers(cwd);

  if (mcpName) {
    return (
      <McpServerDetailView
        name={mcpName}
        scope={mcpScope}
        cwd={cwd}
        onBack={() => router.push("/mcp-servers")}
        getServer={getServer}
        onDelete={async (n, s) => {
          const ok = await deleteServer(n, s);
          return ok;
        }}
      />
    );
  }

  return <McpServerList servers={servers} loading={loading} />;
}

function McpServerList({
  servers,
  loading,
}: {
  servers: { name: string; scope: "user" | "project"; type: string; command?: string; url?: string }[];
  loading: boolean;
}) {
  const router = useRouter();
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
    router.push(`/mcp-servers?mcp=${encodeURIComponent(name)}&scope=${scope}`);
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
        <p className="text-sm text-muted-foreground">No MCP servers configured. Add one to get started.</p>
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
                type={server.type}
                detail={server.command || server.url}
                onClick={() => handleClick(server.name, "user")}
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
                type={server.type}
                detail={server.command || server.url}
                onClick={() => handleClick(server.name, "project")}
              />
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog
        open={scopeDialog}
        onOpenChange={(open) => {
          setScopeDialog(open);
          if (!open) setPickingDir(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New MCP Server</DialogTitle>
          </DialogHeader>
          {pickingDir ? (
            <DirectoryPicker onSelect={(dir) => handleNew("project", dir)} onCancel={() => setPickingDir(false)} />
          ) : (
            <>
              <p className="text-sm text-muted-foreground mb-4">Where should this server be saved?</p>
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
    </div>
  );
}

function ServerRow({ name, type, detail, onClick }: { name: string; type: string; detail?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded px-2 py-2 hover:bg-muted transition-colors text-left"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-sm truncate">{name}</span>
          <Badge variant="secondary" className="text-[10px]">
            {type}
          </Badge>
        </div>
        {detail && <p className="text-xs text-muted-foreground truncate mt-0.5">{detail}</p>}
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </button>
  );
}

function McpServerDetailView({
  name: rawName,
  scope,
  cwd,
  onBack,
  getServer,
  onDelete,
}: {
  name: string;
  scope: "user" | "project";
  cwd: string | undefined;
  onBack: () => void;
  getServer: (
    name: string,
    scope: "user" | "project",
    cwd?: string,
  ) => Promise<{ name: string; scope: string; config: McpServerConfig } | null>;
  onDelete: (name: string, scope: "user" | "project") => Promise<boolean>;
}) {
  const name = decodeURIComponent(rawName);
  const router = useRouter();

  const [config, setConfig] = useState<McpServerConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ success: boolean; logs: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    getServer(name, scope, cwd)
      .then((data) => {
        if (data?.config) {
          setConfig(data.config);
        } else {
          setNotFound(true);
        }
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [name, scope, cwd, getServer]);

  async function handleTest() {
    setActionBusy("test");
    setActionError(null);
    setTestResult(null);
    try {
      const params = new URLSearchParams({ scope });
      if (scope === "project" && cwd) params.set("cwd", cwd);
      const res = await fetch(`/api/mcp-servers/${encodeURIComponent(name)}/test?${params}`, { method: "POST" });
      const data = await res.json();
      setTestResult(data);
    } catch {
      setTestResult({ success: false, logs: "Request failed" });
    } finally {
      setActionBusy(null);
    }
  }

  async function handleDelete() {
    setConfirmDelete(false);
    setActionBusy("delete");
    setActionError(null);
    const ok = await onDelete(name, scope);
    if (ok) {
      onBack();
    } else {
      setActionError("Failed to delete server");
      setActionBusy(null);
    }
  }

  function handleEdit() {
    const params = new URLSearchParams({ scope });
    if (scope === "project" && cwd) params.set("cwd", cwd);
    router.push(`/mcp-servers/${encodeURIComponent(name)}?${params}`);
  }

  if (loading) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        <BackLink onClick={onBack} />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (notFound || !config) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        <BackLink onClick={onBack} />
        <p className="text-sm text-muted-foreground">Server not found.</p>
      </div>
    );
  }

  const serversType = config.type || (config.command ? "stdio" : config.url ? "http" : "stdio");
  const envKeys = config.env ? Object.keys(config.env) : [];
  const headerKeys = config.headers ? Object.keys(config.headers) : [];

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-6">
      <BackLink onClick={onBack} />

      <div>
        <h1 className="font-mono font-bold text-lg">{name}</h1>
      </div>

      {actionError && <div className="rounded border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500">{actionError}</div>}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Scope</span>
            <Badge variant="secondary" className="text-[10px]">
              {scope === "user" ? "Global" : "Project"}
            </Badge>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Type</span>
            <span className="font-mono">{serversType}</span>
          </div>
          {config.command && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Command</span>
              <span className="font-mono text-xs truncate ml-4 max-w-[60%] text-right" title={config.command}>
                {config.command}
              </span>
            </div>
          )}
          {config.args && config.args.length > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Arguments</span>
              <span className="font-mono text-xs text-right max-w-[60%] break-words" title={config.args.join(" ")}>
                {config.args.join(", ")}
              </span>
            </div>
          )}
          {config.url && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">URL</span>
              <span className="font-mono text-xs truncate ml-4 max-w-[60%] text-right" title={config.url}>
                {config.url}
              </span>
            </div>
          )}
          {envKeys.length > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Environment</span>
              <span className="text-xs text-right max-w-[60%] break-words">
                {envKeys.map((k) => (
                  <span key={k} className="block font-mono">
                    {k}={config.env![k]}
                  </span>
                ))}
              </span>
            </div>
          )}
          {headerKeys.length > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Headers</span>
              <span className="text-xs text-right max-w-[60%] break-words">
                {headerKeys.map((k) => (
                  <span key={k} className="block font-mono">
                    {k}: {config.headers![k]}
                  </span>
                ))}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Actions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm">Test connection</span>
            <Button size="sm" variant="outline" onClick={handleTest} disabled={actionBusy !== null}>
              {actionBusy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Test"}
            </Button>
          </div>
          {testResult && (
            <div
              className={`rounded border p-2 text-xs ${testResult.success ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span className={`inline-block h-2 w-2 rounded-full ${testResult.success ? "bg-green-500" : "bg-red-500"}`} />
                <span className="font-medium">{testResult.success ? "Connected" : "Failed"}</span>
              </div>
              <pre className="whitespace-pre-wrap text-muted-foreground font-mono leading-relaxed">{testResult.logs}</pre>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-sm">Edit configuration</span>
            <Button size="sm" variant="outline" onClick={handleEdit} disabled={actionBusy !== null}>
              Edit
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Delete server</span>
            <Button size="sm" variant="destructive" onClick={() => setConfirmDelete(true)} disabled={actionBusy !== null}>
              {actionBusy === "delete" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Server</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">
            Delete <span className="font-mono font-bold">{name}</span>? This cannot be undone.
          </p>
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

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
    >
      <ArrowLeft className="h-4 w-4" />
      Back to MCP Servers
    </button>
  );
}
