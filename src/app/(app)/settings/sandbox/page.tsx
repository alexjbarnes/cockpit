"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import type { SandboxRules } from "@/types";

interface RulesResponse {
  path: string;
  rules: SandboxRules;
  version: string;
  enabledInFile?: boolean;
}

type ListField = Exclude<{ [K in keyof SandboxRules]: SandboxRules[K] extends string[] ? K : never }[keyof SandboxRules], undefined>;

const LIST_FIELDS: { field: ListField; label: string; hint: string; placeholder: string }[] = [
  {
    field: "allowedDomains",
    label: "Allowed domains",
    hint: "Hosts sandboxed commands may reach. Sessions can add their own on top.",
    placeholder: "github.com\n*.npmjs.org",
  },
  { field: "deniedDomains", label: "Denied domains", hint: "Always blocked, even when allowed elsewhere.", placeholder: "example.com" },
  {
    field: "excludedCommands",
    label: "Commands run outside the sandbox",
    hint: "Matched like Bash permission rules. They still go through the usual permission check.",
    placeholder: "docker compose *\nnpx playwright test *",
  },
  {
    field: "allowWrite",
    label: "Extra writable paths",
    hint: "The working directory is always writable.",
    placeholder: "~/.npm\n/tmp/build",
  },
  { field: "denyWrite", label: "Never writable", hint: "Takes precedence over writable paths.", placeholder: "~/.ssh" },
  { field: "denyRead", label: "Never readable", hint: "Everything else stays readable.", placeholder: "~/.aws\n~/.ssh" },
  {
    field: "allowRead",
    label: "Readable inside a denied path",
    hint: "Re-opens a path under one of the above.",
    placeholder: "~/.ssh/known_hosts",
  },
  {
    field: "allowUnixSockets",
    label: "Unix sockets",
    hint: "Socket paths sandboxed commands may connect to. macOS only.",
    placeholder: "~/.docker/run/docker.sock",
  },
];

const toText = (list: string[]) => list.join("\n");
const toList = (text: string) =>
  text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

function Toggle({ enabled, onToggle, testId }: { enabled: boolean; onToggle: () => void; testId: string }) {
  return (
    <button onClick={onToggle} className="shrink-0" role="switch" aria-checked={enabled} data-testid={testId}>
      <span
        className={`inline-flex h-7 w-12 items-center rounded-full transition-colors ${enabled ? "bg-emerald-500" : "bg-muted-foreground/30"}`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`}
        />
      </span>
    </button>
  );
}

export default function SandboxSettingsPage() {
  usePageHeader("Sandbox", { hideActions: true });
  const router = useRouter();
  const [loaded, setLoaded] = useState<RulesResponse | null>(null);
  const [texts, setTexts] = useState<Record<ListField, string> | null>(null);
  // Flags as the CLI reads them: allowLocalBinding defaults off,
  // allowUnsandboxedCommands defaults on.
  const [localBinding, setLocalBinding] = useState(false);
  const [unsandboxed, setUnsandboxed] = useState(true);
  const [status, setStatus] = useState<{ kind: "saved" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const adopt = useCallback((data: RulesResponse) => {
    setLoaded(data);
    setTexts(Object.fromEntries(LIST_FIELDS.map(({ field }) => [field, toText(data.rules[field])])) as Record<ListField, string>);
    setLocalBinding(data.rules.allowLocalBinding === true);
    setUnsandboxed(data.rules.allowUnsandboxedCommands !== false);
  }, []);

  const load = useCallback(() => {
    setStatus(null);
    fetch("/api/sandbox/rules")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
        adopt(body as RulesResponse);
      })
      .catch((err: Error) => setStatus({ kind: "error", text: err.message }));
  }, [adopt]);

  useEffect(load, [load]);

  async function save() {
    if (!texts) return;
    setSaving(true);
    setStatus(null);
    const rules: Partial<SandboxRules> & { baseVersion?: string } = Object.fromEntries(
      LIST_FIELDS.map(({ field }) => [field, toList(texts[field])]),
    );
    // The file is also written by Claude Code itself (a host allowed for good
    // from a network card lands here), so the save names the version it edited.
    rules.baseVersion = loaded?.version;
    // A flag at the CLI's default is left out, so the file stays free of it.
    if (localBinding) rules.allowLocalBinding = true;
    if (!unsandboxed) rules.allowUnsandboxedCommands = false;
    try {
      const r = await fetch("/api/sandbox/rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rules),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `Save failed (${r.status})`);
      adopt(body as RulesResponse);
      setStatus({ kind: "saved", text: "Saved. Running sessions pick this up straight away." });
    } catch (err) {
      setStatus({ kind: "error", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
      <Button variant="ghost" size="sm" className="mb-4" onClick={() => router.push("/settings")}>
        <ArrowLeft className="h-4 w-4 mr-1" />
        Settings
      </Button>
      <div className="max-w-2xl space-y-4">
        <p className="text-sm text-muted-foreground">
          These are Claude Code&apos;s own sandbox rules, kept in{" "}
          <span className="font-mono text-xs">{loaded?.path ?? "~/.claude/settings.json"}</span>. They apply to every sandboxed Claude
          session, in cockpit or not. Whether a session is sandboxed at all is its own Sandbox Bash switch.
        </p>
        {loaded?.enabledInFile && (
          <p className="text-xs text-muted-foreground" data-testid="sandbox-enabled-in-file">
            This file also switches the sandbox on for Claude sessions started outside cockpit.
          </p>
        )}

        {texts && (
          <>
            {LIST_FIELDS.map(({ field, label, hint, placeholder }) => (
              <div key={field} className="space-y-1">
                <label className="text-sm" htmlFor={`sandbox-${field}`}>
                  {label}
                </label>
                <textarea
                  id={`sandbox-${field}`}
                  data-testid={`sandbox-${field}`}
                  value={texts[field]}
                  onChange={(e) => setTexts({ ...texts, [field]: e.target.value })}
                  placeholder={placeholder}
                  rows={3}
                  className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
            ))}

            <div className="flex items-start justify-between gap-4 py-1">
              <div>
                <div className="text-sm">Allow local ports</div>
                <p className="text-xs text-muted-foreground">
                  Lets sandboxed commands start and reach servers on localhost, which opens every local port to them. macOS only.
                </p>
              </div>
              <Toggle enabled={localBinding} onToggle={() => setLocalBinding(!localBinding)} testId="sandbox-allowLocalBinding" />
            </div>
            <div className="flex items-start justify-between gap-4 py-1">
              <div>
                <div className="text-sm">Let commands ask to run outside the sandbox</div>
                <p className="text-xs text-muted-foreground">
                  Off, a command the sandbox blocks can&apos;t be retried outside it. On, the retry always needs your approval in cockpit.
                </p>
              </div>
              <Toggle enabled={unsandboxed} onToggle={() => setUnsandboxed(!unsandboxed)} testId="sandbox-allowUnsandboxedCommands" />
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button size="sm" onClick={save} disabled={saving} data-testid="sandbox-save">
                {saving ? "Saving…" : "Save"}
              </Button>
              {status && (
                <span
                  className={`text-xs ${status.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}
                  data-testid="sandbox-status"
                >
                  {status.text}
                </span>
              )}
              {status?.kind === "error" && (
                <Button size="sm" variant="outline" onClick={load} data-testid="sandbox-reload">
                  Reload
                </Button>
              )}
            </div>
          </>
        )}
        {!texts && status?.kind === "error" && (
          <p className="text-sm text-destructive" data-testid="sandbox-status">
            {status.text}
          </p>
        )}
      </div>
    </div>
  );
}
