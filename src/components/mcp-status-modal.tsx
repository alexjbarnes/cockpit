"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Plug, X, Loader2, RefreshCw, Settings, Power, PowerOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { InitData } from "@/types";

interface McpServer {
  name: string;
  status: string;
  scope?: string;
  error?: string;
  tools?: { name: string }[];
  config?: { type?: string; command?: string; url?: string };
  serverInfo?: { name?: string; version?: string };
}

function statusColor(status: string): string {
  switch (status) {
    case "connected": return "bg-green-500";
    case "disabled": return "bg-muted-foreground/40";
    case "failed": return "bg-red-500";
    default: return "bg-yellow-500";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "connected": return "Connected";
    case "disabled": return "Disabled";
    case "failed": return "Failed";
    default: return status;
  }
}

export function McpStatusButton({ cwd, initData }: { cwd?: string; initData?: InitData | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const sessionId = pathname.match(/^\/sessions\/([^/?]+)/)?.[1] || null;

  // Use initData directly for instant display
  useEffect(() => {
    if (initData?.mcpServers) {
      setServers(initData.mcpServers.map((s) => ({ name: s.name, status: s.status })));
    }
  }, [initData]);

  // Refresh by re-querying mcp_status (used after toggle/reconnect)
  const refreshStatus = useCallback(() => {
    if (!sessionId) return;
    setLoading(true);
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/mcp`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch");
        return res.json();
      })
      .then((data) => {
        const mcpServers = data.mcpServers
          || data.response?.mcpServers
          || data.response?.response?.mcpServers;
        if (mcpServers) setServers(mcpServers);
      })
      .catch(() => {
        // Keep existing data on failure
      })
      .finally(() => setLoading(false));
  }, [sessionId]);

  // Listen for /mcp slash command
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("cockpit:open-mcp", handler);
    return () => window.removeEventListener("cockpit:open-mcp", handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  // No fetch on open - initData is already loaded

  const handleToggle = useCallback(async (serverName: string, currentStatus: string) => {
    if (!sessionId) return;
    const enabled = currentStatus === "disabled";
    setActionLoading(serverName);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle", serverName, enabled }),
      });
      // Refresh status after toggle
      await new Promise((r) => setTimeout(r, 500));
      refreshStatus();
    } catch {
      // ignore
    } finally {
      setActionLoading(null);
    }
  }, [sessionId, refreshStatus]);

  const handleReconnect = useCallback(async (serverName: string) => {
    if (!sessionId) return;
    setActionLoading(serverName);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reconnect", serverName }),
      });
      await new Promise((r) => setTimeout(r, 1000));
      refreshStatus();
    } catch {
      // ignore
    } finally {
      setActionLoading(null);
    }
  }, [sessionId, refreshStatus]);

  const serverCount = initData?.mcpServers?.length ?? 0;
  if (serverCount === 0) return null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        title="MCP servers"
      >
        <Plug className="h-4 w-4" />
      </Button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-lg mx-4 rounded-lg border bg-background p-5 shadow-lg max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Plug className="h-4 w-4" />
                <h2 className="text-base font-semibold">MCP Servers</h2>
                <Badge variant="secondary" className="text-xs">{servers.length}</Badge>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" onClick={refreshStatus} title="Refresh">
                  <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => setOpen(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {loading && servers.length === 0 && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {!loading && error && (
              <p className="text-sm text-muted-foreground py-4 text-center">{error}</p>
            )}

            {servers.length > 0 && (
              <div className="flex-1 min-h-0 overflow-y-auto border rounded">
                {servers.map((server) => (
                  <div
                    key={server.name}
                    className="flex items-center gap-3 px-3 py-2.5 border-b last:border-b-0"
                  >
                    <div className={cn("h-2 w-2 rounded-full shrink-0", statusColor(server.status))} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-bold truncate">{server.name}</span>
                        {server.scope && (
                          <Badge variant="outline" className="text-[10px] shrink-0">{server.scope}</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-muted-foreground">{statusLabel(server.status)}</span>
                        {server.tools && server.tools.length > 0 && (
                          <span className="text-xs text-muted-foreground">{server.tools.length} tools</span>
                        )}
                        {server.config?.type && (
                          <span className="text-xs text-muted-foreground">{server.config.type}</span>
                        )}
                      </div>
                      {server.error && (
                        <p className="text-xs text-red-500 mt-0.5 truncate">{server.error}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {server.status === "failed" && sessionId && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => handleReconnect(server.name)}
                          disabled={actionLoading === server.name}
                          title="Reconnect"
                        >
                          <RefreshCw className={cn("h-3.5 w-3.5", actionLoading === server.name && "animate-spin")} />
                        </Button>
                      )}
                      {sessionId && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => handleToggle(server.name, server.status)}
                          disabled={actionLoading === server.name}
                          title={server.status === "disabled" ? "Enable" : "Disable"}
                        >
                          {server.status === "disabled" ? (
                            <Power className="h-3.5 w-3.5" />
                          ) : (
                            <PowerOff className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!loading && servers.length === 0 && !error && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No MCP servers configured
              </p>
            )}

            <div className="flex justify-end mt-3">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  setOpen(false);
                  router.push("/mcp-servers");
                }}
              >
                <Settings className="h-3.5 w-3.5" />
                Manage servers
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
