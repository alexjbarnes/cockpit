"use client";

import { ArrowLeft, Check, ChevronDown, FolderOpen, GitBranch, Loader2, Terminal, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSettings } from "@/hooks/use-settings";
import { ALL_PROVIDERS, modelTuning, selectionSummary } from "@/lib/model-picker";
import { CONTEXT_SIZES, describeModelSelection } from "@/lib/models";
import {
  applyModelPick,
  draftFromDefaults,
  modelIsAnthropic,
  type NewSessionDraft,
  type NewSessionInput,
  type SessionRuntime,
} from "@/lib/new-session";
import type { NotificationProviderEntry, Provider, SandboxSupport, SessionPermissionMode, ThinkingLevel } from "@/types";
import { DirectoryPicker } from "./directory-picker";
import { ModelPickerList } from "./model-picker-list";
import { SessionNotificationsSettings } from "./session-notifications";

type Step = "where" | "how";
type Tab = "open" | "clone";
type RowId = "notifications" | "model" | "permissions" | "sandbox";

interface NewSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Creates the session. Resolves with the route's answer so the dialog can
   *  stay open with the error instead of discarding what was filled in. */
  onSubmit: (input: NewSessionInput) => Promise<{ ok: boolean; error?: string }>;
}

const PERMISSION_LABELS: Record<SessionPermissionMode, string> = { manual: "Manual", auto: "Auto", bypass: "Bypass" };

export function NewSessionDialog({ open, onOpenChange, onSubmit }: NewSessionDialogProps) {
  const { settings, reload } = useSettings();
  const [step, setStep] = useState<Step>("where");
  const [tab, setTab] = useState<Tab>("open");
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [runtime, setRuntime] = useState<SessionRuntime>("pty");
  const [browsing, setBrowsing] = useState(false);
  const [draft, setDraft] = useState<NewSessionDraft | null>(null);
  const [expanded, setExpanded] = useState<RowId | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  // Loaded when the dialog opens: the model list, the notification providers
  // and whether this host can enforce a sandbox.
  const [providers, setProviders] = useState<Provider[]>([]);
  const [notifyProviders, setNotifyProviders] = useState<NotificationProviderEntry[]>([]);
  const [sandboxSupport, setSandboxSupport] = useState<SandboxSupport | null>(null);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState(ALL_PROVIDERS);

  // Clone state
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneDest, setCloneDest] = useState("");
  const [cloneFolderName, setCloneFolderName] = useState("");
  const [cloneBrowsing, setCloneBrowsing] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState("");
  // The last successful clone, so Back and a second press do not clone again.
  const [clonedPath, setClonedPath] = useState<string | null>(null);

  const reset = () => {
    setStep("where");
    setTab("open");
    setCwd("");
    setName("");
    setRuntime("pty");
    setBrowsing(false);
    setDraft(null);
    setExpanded(null);
    setCreating(false);
    setError("");
    setQuery("");
    setProviderFilter(ALL_PROVIDERS);
    setCloneUrl("");
    setCloneDest("");
    setCloneFolderName("");
    setCloneBrowsing(false);
    setCloning(false);
    setCloneError("");
    setClonedPath(null);
  };

  // Fresh defaults for the draft, plus what the dialog's pickers need. Awaiting
  // reload() is what keeps step two from seeding a stale settings snapshot.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void reload();
    fetch("/api/providers")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data)) setProviders(data);
      })
      .catch(() => {});
    fetch("/api/notifications")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { providers?: NotificationProviderEntry[] } | null) => {
        if (!cancelled && data?.providers) setNotifyProviders(data.providers);
      })
      .catch(() => {});
    fetch("/api/sandbox/support")
      .then((res) => res.json())
      .then((data: SandboxSupport) => {
        if (!cancelled) setSandboxSupport(data);
      })
      .catch(() => {
        if (!cancelled)
          setSandboxSupport({ supported: false, networkIsolation: false, platform: "", reason: "Could not check sandbox support" });
      });
    return () => {
      cancelled = true;
    };
  }, [open, reload]);

  // With the gate off, Stream is not an option anywhere. A dialog left open
  // while the setting changes must not keep a hidden choice.
  useEffect(() => {
    if (!settings.streamRuntimeEnabled) setRuntime("pty");
  }, [settings.streamRuntimeEnabled]);

  const close = (value: boolean) => {
    if (!value) reset();
    onOpenChange(value);
  };

  const submit = async (input: NewSessionInput) => {
    setCreating(true);
    setError("");
    try {
      const result = await onSubmit(input);
      if (result.ok) {
        reset();
        onOpenChange(false);
      } else {
        setError(result.error || "Could not create the session");
      }
    } catch {
      setError("Failed to connect");
    } finally {
      setCreating(false);
    }
  };

  const seedDraft = async () => {
    const fresh = await reload();
    setDraft((prev) => prev ?? draftFromDefaults(fresh, providers, fresh.allowSonnet1m));
  };

  const configure = async () => {
    if (!cwd.trim()) return;
    await seedDraft();
    setExpanded(null);
    setStep("how");
  };

  const clone = async (): Promise<string | null> => {
    setCloning(true);
    setCloneError("");
    try {
      const res = await fetch("/api/git/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: cloneUrl.trim(),
          parentPath: cloneDest.trim(),
          folderName: cloneFolderName.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCloneError(data.error || "Clone failed");
        return null;
      }
      setClonedPath(data.path);
      setCwd(data.path);
      return data.path as string;
    } catch {
      setCloneError("Failed to connect");
      return null;
    } finally {
      setCloning(false);
    }
  };

  const cloneAndConfigure = async () => {
    const path = clonedPath ?? (await clone());
    if (!path) return;
    await seedDraft();
    setExpanded(null);
    setStep("how");
  };

  const cloneAndCreate = async () => {
    const path = clonedPath ?? (await clone());
    if (!path) return;
    await submit({ cwd: path, name: name.trim(), runtime });
  };

  const tuning = draft ? modelTuning(draft.model, draft.contextSize, providers, settings.allowSonnet1m) : null;
  const selection = draft ? describeModelSelection(draft.model, draft.thinkingLevel, draft.contextSize, providers) : null;
  const summary = selection ? selectionSummary(selection, tuning?.parsed.entry !== null) : null;
  const autoAvailable = draft ? modelIsAnthropic(draft.model, providers) : true;
  const notifyName = draft?.notifications?.providerId
    ? (notifyProviders.find((p) => p.id === draft.notifications?.providerId)?.name ?? "Configured provider")
    : null;
  const sandboxValue = !sandboxSupport?.supported ? "Not supported" : draft?.sandbox.enabled ? "On" : "Off";

  const createFromDraft = async () => {
    if (!draft || !tuning) return;
    const contextSize = tuning.contextSizes.includes(draft.contextSize) ? draft.contextSize : (tuning.contextSizes[0] ?? draft.contextSize);
    await submit({
      cwd: cwd.trim(),
      name: name.trim(),
      runtime,
      model: draft.model,
      contextSize,
      thinkingLevel: draft.thinkingLevel,
      permissionMode: draft.permissionMode,
      sandbox: sandboxSupport && !sandboxSupport.supported ? { enabled: false } : draft.sandbox,
      notifications: draft.notifications,
    });
  };

  const toggleRow = (row: RowId) => setExpanded((prev) => (prev === row ? null : row));

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="flex max-h-full min-h-0 w-full max-w-lg flex-col p-4 sm:p-6"
        data-testid="new-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        onClose={() => close(false)}
      >
        <DialogHeader>
          <DialogTitle id="new-session-title" className="flex items-center gap-2">
            {step === "how" && (
              <button
                type="button"
                onClick={() => setStep("where")}
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Back to where"
                aria-label="Back to where"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            {step === "where" ? "New session" : "Configure this session"}
          </DialogTitle>
        </DialogHeader>

        {step === "where" && (
          <div className="mt-2 flex min-h-0 flex-1 flex-col" data-testid="new-session-step-where">
            <div className="flex shrink-0 gap-1 border-b">
              <button
                type="button"
                onClick={() => setTab("open")}
                data-testid="new-session-tab-open"
                className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
                  tab === "open" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                Open directory
              </button>
              <button
                type="button"
                onClick={() => setTab("clone")}
                data-testid="new-session-tab-clone"
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
                  tab === "clone" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <GitBranch className="h-3.5 w-3.5" />
                Clone repo
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pt-3">
              {tab === "open" && (
                <>
                  <div>
                    <label className="text-sm font-medium">Working directory</label>
                    <div className="flex gap-2">
                      <Input
                        value={cwd}
                        onChange={(e) => setCwd(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void configure();
                        }}
                        placeholder="/home/user/project"
                        data-testid="new-session-cwd"
                        autoFocus
                      />
                      <Button type="button" variant="outline" size="icon" onClick={() => setBrowsing(!browsing)} title="Browse directories">
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  {browsing && (
                    <DirectoryPicker
                      onSelect={(path) => {
                        setCwd(path);
                        setBrowsing(false);
                      }}
                      onCancel={() => setBrowsing(false)}
                    />
                  )}
                  <div>
                    <label className="text-sm font-medium">Name (optional)</label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My project" data-testid="new-session-name" />
                  </div>
                </>
              )}

              {tab === "clone" && (
                <>
                  <div>
                    <label className="text-sm font-medium">Repository URL</label>
                    <Input
                      value={cloneUrl}
                      onChange={(e) => {
                        setCloneUrl(e.target.value);
                        setClonedPath(null);
                      }}
                      placeholder="https://github.com/user/repo.git"
                      data-testid="new-session-clone-url"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Clone into</label>
                    <div className="flex gap-2">
                      <Input
                        value={cloneDest}
                        onChange={(e) => {
                          setCloneDest(e.target.value);
                          setClonedPath(null);
                        }}
                        placeholder="/home/user/projects"
                        data-testid="new-session-clone-dest"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => setCloneBrowsing(!cloneBrowsing)}
                        title="Browse directories"
                      >
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  {cloneBrowsing && (
                    <DirectoryPicker
                      onSelect={(path) => {
                        setCloneDest(path);
                        setCloneBrowsing(false);
                      }}
                      onCancel={() => setCloneBrowsing(false)}
                    />
                  )}
                  <div>
                    <label className="text-sm font-medium">Folder name (optional)</label>
                    <Input
                      value={cloneFolderName}
                      onChange={(e) => {
                        setCloneFolderName(e.target.value);
                        setClonedPath(null);
                      }}
                      placeholder="Defaults to the repository name"
                      data-testid="new-session-clone-folder"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Session name (optional)</label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My project" data-testid="new-session-name" />
                  </div>
                  {clonedPath && <p className="text-xs text-muted-foreground">Cloned to {clonedPath}</p>}
                  {cloneError && <p className="text-sm text-destructive">{cloneError}</p>}
                </>
              )}

              {settings.streamRuntimeEnabled && (
                <div>
                  <span className="text-sm font-medium">Runtime</span>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <RuntimeButton
                      active={runtime === "pty"}
                      testId="new-session-runtime-pty"
                      icon={<Terminal className="h-3.5 w-3.5" />}
                      label="PTY (interactive)"
                      onClick={() => setRuntime("pty")}
                    />
                    <RuntimeButton
                      active={runtime === "stream"}
                      testId="new-session-runtime-stream"
                      icon={<Zap className="h-3.5 w-3.5" />}
                      label="Stream (headless)"
                      badge="Deprecated"
                      onClick={() => setRuntime("stream")}
                    />
                  </div>
                </div>
              )}

              {error && (
                <p className="text-sm text-destructive" data-testid="new-session-error">
                  {error}
                </p>
              )}
            </div>

            <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t bg-background pt-3">
              <Button type="button" variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              {tab === "open" ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="new-session-create-defaults"
                    disabled={!cwd.trim() || creating}
                    onClick={() => void submit({ cwd: cwd.trim(), name: name.trim(), runtime })}
                  >
                    Create with defaults
                  </Button>
                  <Button
                    type="button"
                    data-testid="new-session-configure"
                    disabled={!cwd.trim() || creating}
                    onClick={() => void configure()}
                  >
                    Configure →
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="new-session-clone-defaults"
                    disabled={!cloneUrl.trim() || !cloneDest.trim() || cloning || creating}
                    onClick={() => void cloneAndCreate()}
                  >
                    {cloning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Clone with defaults
                  </Button>
                  <Button
                    type="button"
                    data-testid="new-session-clone-configure"
                    disabled={!cloneUrl.trim() || !cloneDest.trim() || cloning || creating}
                    onClick={() => void cloneAndConfigure()}
                  >
                    {cloning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {clonedPath ? "Continue →" : "Clone & configure"}
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {step === "how" && draft && tuning && summary && (
          <div className="mt-2 flex min-h-0 flex-1 flex-col" data-testid="new-session-step-how">
            <div className="flex shrink-0 items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 break-all font-mono" data-testid="new-session-where-summary">
                {cwd.trim()}
              </span>
              {name.trim() && <span className="shrink-0 text-muted-foreground">{name.trim()}</span>}
            </div>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pt-3">
              <Row
                id="notifications"
                label="Notifications"
                value={notifyName ?? "Off"}
                expanded={expanded === "notifications"}
                onToggle={() => toggleRow("notifications")}
              >
                <SessionNotificationsSettings
                  notifications={draft.notifications}
                  providers={notifyProviders}
                  onChange={(next) => setDraft({ ...draft, notifications: next })}
                  testIdPrefix="new-session-notify"
                />
              </Row>

              <Row
                id="model"
                label="Model"
                value={
                  <span className="flex min-w-0 flex-col items-end">
                    <span className="max-w-full truncate">{summary.name}</span>
                    {summary.detail && <span className="max-w-full truncate text-muted-foreground">{summary.detail}</span>}
                  </span>
                }
                expanded={expanded === "model"}
                onToggle={() => toggleRow("model")}
              >
                <div className="space-y-3">
                  {tuning.contextSizes.length >= 2 && (
                    <div className="space-y-1">
                      <span className="text-[11px] font-medium text-muted-foreground">Context</span>
                      <div className="flex flex-wrap gap-1">
                        {tuning.contextSizes.map((size) => (
                          <Pill
                            key={size}
                            active={draft.contextSize === size}
                            testId={`new-session-context-${size}`}
                            onClick={() => setDraft({ ...draft, contextSize: size })}
                          >
                            {CONTEXT_SIZES[size].label}
                          </Pill>
                        ))}
                      </div>
                    </div>
                  )}
                  {tuning.thinkingLevels.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-[11px] font-medium text-muted-foreground">Thinking</span>
                      <div className="flex flex-wrap gap-1">
                        {tuning.thinkingLevels.map((level) => (
                          <Pill
                            key={level.value}
                            active={draft.thinkingLevel === level.value}
                            testId={`new-session-thinking-${level.value}`}
                            onClick={() => setDraft({ ...draft, thinkingLevel: level.value as ThinkingLevel })}
                          >
                            {level.label}
                          </Pill>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex h-56 min-h-0 flex-col" data-testid="new-session-model-picker">
                    <ModelPickerList
                      currentModel={draft.model}
                      providers={providers}
                      recentModels={[]}
                      onSelectModel={(value) => setDraft(applyModelPick(draft, value, providers, settings.allowSonnet1m))}
                      tuning={tuning}
                      query={query}
                      onQuery={setQuery}
                      providerFilter={providerFilter}
                      onProviderFilter={setProviderFilter}
                    />
                  </div>
                </div>
              </Row>

              <Row
                id="permissions"
                label="Permissions"
                value={PERMISSION_LABELS[draft.permissionMode]}
                expanded={expanded === "permissions"}
                onToggle={() => toggleRow("permissions")}
              >
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Permission mode">
                    {(["manual", "auto", "bypass"] as const).map((mode) => {
                      const disabled = mode === "auto" && !autoAvailable;
                      return (
                        <button
                          key={mode}
                          type="button"
                          role="radio"
                          aria-checked={draft.permissionMode === mode}
                          disabled={disabled}
                          data-testid={`new-session-perm-${mode}`}
                          onClick={() => setDraft({ ...draft, permissionMode: mode })}
                          className={`rounded px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ${
                            draft.permissionMode === mode
                              ? mode === "bypass"
                                ? "bg-orange-500 text-white"
                                : "bg-primary text-primary-foreground"
                              : "bg-muted text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {PERMISSION_LABELS[mode]}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {draft.permissionMode === "manual"
                      ? "Every tool call asks first."
                      : draft.permissionMode === "auto"
                        ? "Safe steps run; risky ones are blocked until you agree."
                        : "All tool calls are auto-approved."}
                    {!autoAvailable && " Auto needs an Anthropic model."}
                  </p>
                </div>
              </Row>

              <Row
                id="sandbox"
                label="Sandbox Bash"
                value={sandboxValue}
                expanded={expanded === "sandbox"}
                onToggle={() => toggleRow("sandbox")}
              >
                <div className="space-y-2">
                  <button
                    type="button"
                    data-testid="new-session-sandbox-toggle"
                    disabled={!sandboxSupport?.supported}
                    onClick={() => setDraft({ ...draft, sandbox: { ...draft.sandbox, enabled: !draft.sandbox.enabled } })}
                    className="flex w-full items-center justify-between rounded-lg border px-3 py-2 text-xs disabled:opacity-60"
                  >
                    <span>{draft.sandbox.enabled ? "On" : "Off"}</span>
                    <span
                      className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                        draft.sandbox.enabled ? "bg-emerald-500" : "bg-muted-foreground/30"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                          draft.sandbox.enabled ? "translate-x-4.5" : "translate-x-0.5"
                        }`}
                      />
                    </span>
                  </button>
                  {!sandboxSupport?.supported ? (
                    <p className="text-[11px] text-muted-foreground">{sandboxSupport?.reason ?? "Checking sandbox support…"}</p>
                  ) : draft.sandbox.enabled ? (
                    <div className="space-y-1">
                      <span className="text-[11px] text-muted-foreground">Allowed network domains (one per line)</span>
                      <textarea
                        data-testid="new-session-sandbox-domains"
                        key={String(draft.sandbox.enabled)}
                        defaultValue={(draft.sandbox.allowedDomains ?? []).join("\n")}
                        placeholder={"github.com\n*.npmjs.org"}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            sandbox: {
                              enabled: true,
                              allowedDomains: e.target.value
                                .split("\n")
                                .map((d) => d.trim())
                                .filter(Boolean),
                            },
                          })
                        }
                        rows={3}
                        className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      Bash runs isolated and its commands auto-run, even in Manual. Shared rules live in Settings → Sandbox.
                    </p>
                  )}
                </div>
              </Row>
            </div>

            {error && (
              <p className="shrink-0 pt-2 text-sm text-destructive" data-testid="new-session-error">
                {error}
              </p>
            )}

            <div className="mt-2 flex shrink-0 justify-end gap-2 border-t bg-background pt-3">
              <Button type="button" variant="outline" data-testid="new-session-back" onClick={() => setStep("where")}>
                Back
              </Button>
              <Button type="button" data-testid="new-session-create" disabled={creating} onClick={() => void createFromDraft()}>
                {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Create session
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RuntimeButton({
  active,
  testId,
  icon,
  label,
  badge,
  onClick,
}: {
  active: boolean;
  testId: string;
  icon: React.ReactNode;
  label: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
        active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted/50"
      }`}
    >
      {icon}
      {label}
      {badge && (
        <span className="rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
          {badge}
        </span>
      )}
      {active && <Check className="h-3 w-3 text-primary" />}
    </button>
  );
}

function Pill({ active, testId, onClick, children }: { active: boolean; testId: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
        active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function Row({
  id,
  label,
  value,
  expanded,
  onToggle,
  children,
}: {
  id: RowId;
  label: string;
  value: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`new-session-panel-${id}`}
        data-testid={`new-session-row-${id}`}
        className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-xs"
      >
        <span className="shrink-0 font-medium">{label}</span>
        <span className="min-w-0 flex-1 text-right text-muted-foreground">{value}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <div id={`new-session-panel-${id}`} role="region" className="border-t px-3 py-3">
          {children}
        </div>
      )}
    </div>
  );
}
