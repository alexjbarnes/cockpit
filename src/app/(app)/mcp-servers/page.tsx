"use client";

import { ArrowLeft, Check, ChevronRight, Copy, ExternalLink, Eye, EyeOff, Loader2, Plus, RefreshCw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { DirectoryPicker } from "@/components/directory-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type LoginStart, type McpServerEntry, useMcpConnectors } from "@/hooks/use-mcp-connectors";
import { type McpServerConfig, useMcpServers } from "@/hooks/use-mcp-servers";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";

export default function McpServersPage() {
  usePageHeader("MCP Servers", { hideActions: true });

  const searchParams = useSearchParams();
  const router = useRouter();
  const mcpName = searchParams.get("mcp");
  const mcpScope = (searchParams.get("scope") || "user") as "user" | "project";

  const cwd = typeof localStorage !== "undefined" ? localStorage.getItem("cockpit-agents-cwd") || undefined : undefined;
  const { servers, loading, getServer, deleteServer } = useMcpServers(cwd);
  const account = useMcpConnectors(cwd);
  const [signInName, setSignInName] = useState<string | null>(null);

  const signInDialog = signInName ? (
    <McpSignInDialog
      name={signInName}
      onClose={() => setSignInName(null)}
      startLogin={account.startLogin}
      submitRedirect={account.submitRedirect}
      cancelLogin={account.cancelLogin}
      onSignedIn={() => account.refresh(true)}
    />
  ) : null;

  if (mcpName) {
    return (
      <>
        <McpServerDetailView
          name={mcpName}
          scope={mcpScope}
          cwd={cwd}
          onBack={() => router.push("/mcp-servers")}
          getServer={getServer}
          onAuthenticate={setSignInName}
          onDelete={async (n, s) => {
            const ok = await deleteServer(n, s);
            return ok;
          }}
        />
        {signInDialog}
      </>
    );
  }

  return (
    <>
      <McpServerList servers={servers} loading={loading} account={account} onAuthenticate={setSignInName} />
      {signInDialog}
    </>
  );
}

function McpServerList({
  servers,
  loading,
  account,
  onAuthenticate,
}: {
  servers: { name: string; scope: "user" | "project"; type: string; command?: string; url?: string }[];
  loading: boolean;
  account: ReturnType<typeof useMcpConnectors>;
  onAuthenticate: (name: string) => void;
}) {
  const router = useRouter();
  const scrollRef = useScrollRestoration<HTMLDivElement>("mcp-servers-scroll");
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
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
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

      <ClaudeAccountCard account={account} onAuthenticate={onAuthenticate} />

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

const STATUS_DOT: Record<McpServerEntry["status"], string> = {
  connected: "bg-green-500",
  "needs-auth": "bg-amber-500",
  failed: "bg-red-500",
  pending: "bg-muted-foreground/40",
};

const STATUS_LABEL: Record<McpServerEntry["status"], string> = {
  connected: "Connected",
  "needs-auth": "Needs authentication",
  failed: "Failed to connect",
  pending: "Pending approval",
};

/**
 * The servers on the Claude account itself. They are not in any config file
 * cockpit can read, so the list comes from the CLI, which health-checks each
 * one and takes a few seconds over it.
 */
function ClaudeAccountCard({
  account,
  onAuthenticate,
}: {
  account: ReturnType<typeof useMcpConnectors>;
  onAuthenticate: (name: string) => void;
}) {
  const connectors = account.servers.filter((s) => s.scope === "connector");

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Claude account</CardTitle>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => account.refresh(true)}
          disabled={account.loading}
          title="Check every server again"
          data-testid="connectors-refresh"
        >
          <RefreshCw className={`h-4 w-4 ${account.loading ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-1">
        {account.error && (
          <div className="rounded border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-500" data-testid="connectors-error">
            {account.error}
          </div>
        )}

        {account.loading && connectors.length === 0 && <p className="text-sm text-muted-foreground">Checking servers...</p>}

        {!account.loading && connectors.length === 0 && !account.error && (
          <p className="text-sm text-muted-foreground" data-testid="connectors-empty">
            No account connectors. Sign in with the CLI on this machine to add some.
          </p>
        )}

        {connectors.map((server) => (
          <div
            key={server.name}
            className="flex flex-col gap-2 rounded px-2 py-2 sm:flex-row sm:items-center sm:gap-3"
            data-testid="connector-row"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[server.status]}`} />
              <div className="min-w-0 flex-1">
                <span className="block font-mono font-bold text-sm truncate">{server.name.replace(/^claude\.ai /, "")}</span>
                <p className="text-xs text-muted-foreground truncate mt-0.5" title={server.detail ?? server.target}>
                  {server.detail ?? server.target}
                </p>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">{STATUS_LABEL[server.status]}</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="w-full shrink-0 sm:w-auto"
              onClick={() => onAuthenticate(server.name)}
              data-testid="connector-authenticate"
            >
              {server.status === "connected" ? "Sign in again" : "Authenticate"}
            </Button>
          </div>
        ))}

        {connectors.length > 0 && (
          <p className="px-2 pt-1 text-xs text-muted-foreground">
            Account connectors load in CLI sessions that sign in with your Claude account. A session running on another provider does not
            use them.
          </p>
        )}
        {account.checkedAt && (
          <p className="px-2 text-xs text-muted-foreground">
            Last checked {new Date(account.checkedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Signing in is the CLI's own flow: it prints a URL to authorise at, and either
 * finishes there (an account connector) or waits for the redirect URL the
 * browser lands on to be pasted back.
 */
function McpSignInDialog({
  name,
  onClose,
  startLogin,
  submitRedirect,
  cancelLogin,
  onSignedIn,
}: {
  name: string;
  onClose: () => void;
  startLogin: (name: string) => Promise<LoginStart>;
  submitRedirect: (id: string, redirectUrl: string) => Promise<{ ok: boolean; error?: string }>;
  cancelLogin: (id: string) => Promise<void>;
  onSignedIn: () => void;
}) {
  const [start, setStart] = useState<LoginStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const startRef = useRef<LoginStart | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    startLogin(name)
      .then((res) => {
        if (cancelled) return;
        startRef.current = res;
        if (!res.ok) setError(res.error ?? "Could not start the sign-in");
        else setStart(res);
      })
      .catch(() => {
        if (!cancelled) setError("Could not start the sign-in");
      });
    return () => {
      cancelled = true;
      const pending = startRef.current;
      if (pending?.id && !doneRef.current) void cancelLogin(pending.id);
    };
  }, [name, startLogin, cancelLogin]);

  function handleCopy() {
    if (!start?.url) return;
    navigator.clipboard?.writeText(start.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleSubmit() {
    if (!start?.id || !redirectUrl.trim()) return;
    setBusy(true);
    setError(null);
    const res = await submitRedirect(start.id, redirectUrl.trim());
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Sign-in failed");
      return;
    }
    doneRef.current = true;
    setDone(true);
    onSignedIn();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="mcp-signin-dialog" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="font-mono font-bold">{name}</DialogTitle>
        </DialogHeader>

        {error && (
          <div className="rounded border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500" data-testid="mcp-signin-error">
            {error}
          </div>
        )}

        {!start && !error && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Asking the CLI for an authorisation URL...
          </p>
        )}

        {done && <p className="text-sm text-green-500">Signed in.</p>}

        {start && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Input readOnly value={start.url ?? ""} className="font-mono text-xs" data-testid="mcp-signin-url" />
              <Button size="sm" variant="outline" onClick={handleCopy} className="shrink-0">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
              <Button size="sm" variant="outline" asChild className="shrink-0">
                <a href={start.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            </div>

            {start.kind === "connector" ? (
              <p className="text-sm text-muted-foreground">
                Authorise on claude.ai, then check the server again. The connector is available the next time a CLI session starts.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">Authorise in the browser, then paste the URL it redirects to here.</p>
                <div className="flex items-center gap-2">
                  <Input
                    value={redirectUrl}
                    onChange={(e) => setRedirectUrl(e.target.value)}
                    placeholder="http://localhost:..."
                    className="font-mono text-xs"
                    data-testid="mcp-signin-redirect-input"
                  />
                  <Button size="sm" onClick={handleSubmit} disabled={busy || !redirectUrl.trim()} data-testid="mcp-signin-submit">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Submit"}
                  </Button>
                </div>
              </>
            )}

            <p className="text-xs text-muted-foreground">
              Signing in replaces the credentials this server already has, so closing this without finishing can leave it disconnected.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** What a masked value shows instead of itself, whatever its real length. */
const MASK = "••••••••";

/**
 * An environment variable or header value: masked until clicked, because these
 * are where API keys and bearer tokens live and the page is as likely to be
 * open while a screen is shared as any other.
 */
function SecretValue({ label, value, separator }: { label: string; value: string; separator: string }) {
  const [shown, setShown] = useState(false);
  const Icon = shown ? EyeOff : Eye;
  return (
    <button
      type="button"
      onClick={() => setShown((s) => !s)}
      title={shown ? "Hide value" : "Show value"}
      aria-pressed={shown}
      data-testid="secret-value"
      className="block w-full font-mono text-right"
    >
      {label}
      {separator}
      {shown ? value : MASK}
      <Icon className="ml-1 inline h-3 w-3 align-text-bottom opacity-60" />
    </button>
  );
}

function McpServerDetailView({
  name: rawName,
  scope,
  cwd,
  onBack,
  getServer,
  onAuthenticate,
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
  onAuthenticate: (name: string) => void;
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
                  <SecretValue key={k} label={k} value={config.env![k]} separator="=" />
                ))}
              </span>
            </div>
          )}
          {headerKeys.length > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Headers</span>
              <span className="text-xs text-right max-w-[60%] break-words">
                {headerKeys.map((k) => (
                  <SecretValue key={k} label={k} value={config.headers![k]} separator=": " />
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
          {serversType !== "stdio" && (
            <div className="flex items-center justify-between">
              <span className="text-sm">Sign in to the server</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onAuthenticate(name)}
                disabled={actionBusy !== null}
                data-testid="server-authenticate"
              >
                Authenticate
              </Button>
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
