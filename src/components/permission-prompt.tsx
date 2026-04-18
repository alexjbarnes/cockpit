"use client";

import { ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { PendingPermission } from "@/hooks/use-session";
import { pathBasename, shortPath } from "@/lib/path";
import type { PermissionMode, PermissionSuggestion } from "@/types";

function formatToolSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
    case "bash": {
      const cmd = (input.command as string) || "";
      return cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
    }
    case "Write":
    case "write":
    case "Edit":
    case "edit":
    case "Read":
    case "read": {
      const fp = (input.file_path as string) || "";
      return fp ? shortPath(fp) : "";
    }
    default:
      return "";
  }
}

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
    return `${s.mode} mode (${dest})`;
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

  const summary = formatToolSummary(permission.toolName, parsed);
  const suggestions = permission.suggestions;
  const hasSuggestions = suggestions && suggestions.length > 0;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-4">
        <div className="flex items-start gap-3">
          <ShieldAlert className="h-5 w-5 shrink-0 text-yellow-500 mt-0.5" />
          <div className="flex-1 min-w-0 space-y-2">
            <div className="text-sm font-medium">
              Permission requested: <span className="font-mono">{permission.toolName}</span>
            </div>
            {summary && <div className="font-mono text-xs text-muted-foreground truncate">{summary}</div>}
            {permission.input && (
              <pre className="overflow-x-auto rounded bg-black/10 dark:bg-white/5 p-2 text-[11px] leading-relaxed max-h-32 overflow-y-auto">
                {permission.input.length > 500 ? permission.input.slice(0, 500) + "\n... (truncated)" : permission.input}
              </pre>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                ref={allowRef}
                onClick={() => onRespond(permission.requestId, true, "allow")}
                className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                Allow
              </button>
              {hasSuggestions ? (
                suggestions.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => onRespond(permission.requestId, true, "allow_always", i)}
                    className="rounded bg-primary/70 px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/60"
                    title={JSON.stringify(s, null, 2)}
                  >
                    {suggestionLabel(s)}
                  </button>
                ))
              ) : (
                <button
                  onClick={() => onRespond(permission.requestId, true, "allow_always")}
                  className="rounded bg-primary/70 px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/60"
                >
                  Always for {permission.toolName}
                </button>
              )}
              <button
                onClick={() => onRespond(permission.requestId, true, "allow_all")}
                className="rounded bg-orange-600 px-3 py-1 text-xs font-medium text-white hover:bg-orange-700"
              >
                Bypass All
              </button>
              <button
                onClick={() => onRespond(permission.requestId, false, "deny")}
                className="rounded bg-muted px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/80"
              >
                Deny
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
