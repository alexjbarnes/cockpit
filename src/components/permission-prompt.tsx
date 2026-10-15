"use client";

import { Globe, ShieldAlert, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PendingPermission } from "@/hooks/use-session";
import { pathBasename } from "@/lib/path";
import { isSandboxEscape, NETWORK_ACCESS_TOOL } from "@/lib/sandbox-requests";
import { formatToolSummary } from "@/lib/tool-summary";
import type { PermissionMode, PermissionSuggestion } from "@/types";

const destinationLabels: Record<string, string> = {
  session: "session",
  localSettings: "project (local)",
  projectSettings: "project",
  userSettings: "global",
  cliArg: "session",
};

function suggestionLabel(s: PermissionSuggestion): string {
  const dest = destinationLabels[s.destination || ""] || s.destination || "session";

  if (s.type === "setMode" && s.mode) {
    // The CLI names its modes for itself ("acceptEdits"); a card offering one
    // as an answer says what it means for the asks that follow.
    const named: Record<string, string> = {
      acceptEdits: "Stop asking about edits",
      bypassPermissions: "Bypass permissions",
      plan: "Plan mode",
      default: "Ask every time",
      auto: "Auto mode",
    };
    return `${named[s.mode] ?? `${s.mode} mode`} (${dest})`;
  }

  if (s.type === "addDirectories" && s.directories?.length) {
    const dir = s.directories[0];
    const short = pathBasename(dir) || dir;
    return `Allow dir ${short} (${dest})`;
  }

  if (!s.rules?.length) {
    return `Always allow (${dest})`;
  }

  const rule = s.rules[0];
  const tool = rule.toolName;
  const content = rule.ruleContent;

  if (!content) {
    return `Always ${tool} (${dest})`;
  }

  const shortContent = content.length > 30 ? content.slice(0, 30) + "..." : content;
  return `${tool}(${shortContent}) (${dest})`;
}

interface PermissionPromptProps {
  permission: PendingPermission;
  onRespond: (requestId: string, allowed: boolean, permissionMode?: PermissionMode, suggestionIndex?: number) => void;
}

/**
 * What the tool is about to do, in full. A Bash call shows its command rather
 * than the JSON that carries it — the command is the decision, and the JSON
 * only hides it behind escapes and a field name.
 *
 * The text wraps rather than scrolling sideways: a command read through a
 * horizontal scrollbar is a command you cannot read. Long input (a whole
 * script, a file's contents) starts in a shorter box and grows to the rest on
 * the toggle, so a card that would push Allow off the screen does not.
 */
function PermissionInput({ toolName, input, parsed }: { toolName: string; input: string; parsed: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const COLLAPSED_CHARS = 500;
  const command = (toolName === "Bash" || toolName === "bash") && typeof parsed.command === "string" ? parsed.command : null;
  const text = command ?? input;

  return (
    <div className="space-y-1" data-testid="permission-input">
      <pre
        data-testid="permission-input-text"
        className={`overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded bg-black/10 p-2 text-xs leading-relaxed dark:bg-white/5 ${
          expanded ? "max-h-[70vh]" : "max-h-40"
        }`}
      >
        {text}
      </pre>
      {text.length > COLLAPSED_CHARS && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          data-testid="btn-toggle-permission-input"
          className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {expanded ? "Show less" : `Show all (${text.length.toLocaleString()} characters)`}
        </button>
      )}
    </div>
  );
}

export function PermissionPrompt({ permission, onRespond }: PermissionPromptProps) {
  const allowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    allowRef.current?.focus();
  }, []);

  const parsed = useMemo(() => {
    if (!permission.input) return {};
    try {
      return JSON.parse(permission.input) as Record<string, unknown>;
    } catch {
      return {};
    }
  }, [permission.input]);

  if (permission.toolName === NETWORK_ACCESS_TOOL) {
    return <NetworkAccessPrompt permission={permission} input={parsed} onRespond={onRespond} />;
  }

  const summary = formatToolSummary(permission.toolName, parsed);
  const suggestions = permission.suggestions ?? [];
  const escapesSandbox = isSandboxEscape(parsed);
  const isCommand = permission.toolName === "Bash" || permission.toolName === "bash";
  // For a command the block below is the whole thing, so repeating its first
  // line above it is noise; for everything else the summary (a path, a URL) is
  // what the raw input hides.
  const detail = isCommand ? "" : summary;

  return (
    <div className="mx-auto max-w-3xl" data-testid="permission-prompt">
      {/* A normal card with one amber rail: the rail is the whole "this needs
          you" signal, and nothing else on the card is tinted. */}
      <div className="rounded-lg border border-l-2 border-l-amber-500 bg-card p-4 text-sm">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Permission requested</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              <span className="font-mono">{permission.toolName}</span>
              {escapesSandbox && <span> · outside the sandbox</span>}
            </div>
            {detail && <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{detail}</div>}
            {escapesSandbox && (
              <div
                className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500"
                data-testid="sandbox-escape-warning"
              >
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                Runs outside the sandbox, with no file or network limits.
              </div>
            )}
            {permission.input && (
              <div className="mt-3">
                <PermissionInput toolName={permission.toolName} input={permission.input} parsed={parsed} />
              </div>
            )}
            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={() => onRespond(permission.requestId, false, "deny")}
                data-testid="btn-deny"
                className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Deny
              </button>
              <span className="flex-1" />
              {/* Only the variants the footer has no room for: the first is the
                  Always button beside this, so a menu of one (or none) would
                  repeat what is already there. Widening permissions past this
                  is the session's own settings, not a card action. */}
              {suggestions.length > 1 && (
                <details className="group relative" data-testid="permission-more">
                  <summary className="cursor-pointer list-none rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
                    More
                  </summary>
                  <div className="absolute right-0 z-10 mt-1.5 min-w-[15rem] rounded-lg border bg-popover p-1.5 shadow-md">
                    {suggestions.slice(1).map((s, i) => (
                      <button
                        key={i}
                        onClick={() => onRespond(permission.requestId, true, "allow_always", i + 1)}
                        title={JSON.stringify(s, null, 2)}
                        className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-accent"
                      >
                        {suggestionLabel(s)}
                      </button>
                    ))}
                  </div>
                </details>
              )}
              {/* The first of the CLI's own alternatives, only when it offered
                  one. There is no cockpit-invented "Always for <tool>": an
                  answer that saves nothing is a button that lies about what it
                  did, and the CLI is the one that knows which rule fits. */}
              {suggestions.length > 0 && (
                <button
                  onClick={() => onRespond(permission.requestId, true, "allow_always", 0)}
                  data-testid="btn-always"
                  className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent"
                >
                  {suggestionLabel(suggestions[0])}
                </button>
              )}
              <button
                ref={allowRef}
                onClick={() => onRespond(permission.requestId, true, "allow")}
                className="rounded-md bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                data-testid="btn-allow"
              >
                Allow
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The CLI's "Network request outside of sandbox" question: a sandboxed command
 * wants a host that is not on the allowed list. The CLI's "Yes" allows the host
 * for the rest of the session; "Always" is its "don't ask again for <host>",
 * which saves a WebFetch(domain:...) allow rule in the project's local settings.
 */
function NetworkAccessPrompt({
  permission,
  input,
  onRespond,
}: {
  permission: PendingPermission;
  input: Record<string, unknown>;
  onRespond: PermissionPromptProps["onRespond"];
}) {
  const allowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    allowRef.current?.focus();
  }, []);
  const host = typeof input.host === "string" ? input.host : "";
  const command = typeof input.command === "string" ? input.command : "";

  return (
    <div className="mx-auto max-w-3xl" data-testid="network-access-prompt">
      <div className="rounded-lg border border-l-2 border-l-amber-500 bg-card p-4 text-sm">
        <div className="flex items-start gap-3">
          <Globe className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="font-medium">Network access requested</span>
              <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{host}</span>
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              A sandboxed command wants to reach a host that isn&apos;t on the allowed list.
            </div>
            {command && (
              <pre className="mt-3 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded bg-black/10 p-2 font-mono text-xs leading-relaxed dark:bg-white/5">
                {command}
              </pre>
            )}
            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={() => onRespond(permission.requestId, false, "deny")}
                data-testid="btn-network-deny"
                className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Deny
              </button>
              <span className="flex-1" />
              <button
                onClick={() => onRespond(permission.requestId, true, "allow_always", 0)}
                data-testid="btn-network-always"
                className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent"
              >
                {host ? `Always allow ${host}` : "Always allow this host"}
              </button>
              <button
                ref={allowRef}
                onClick={() => onRespond(permission.requestId, true, "allow")}
                data-testid="btn-network-allow"
                className="rounded-md bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                Allow for this session
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
