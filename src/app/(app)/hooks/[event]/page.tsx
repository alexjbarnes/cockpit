"use client";

import { Check, Copy, Save } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { CodeEditor } from "@/components/code-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
];

const SCOPE_OPTIONS = [
  { value: "global", label: "Global" },
  { value: "project", label: "Project" },
  { value: "project-local", label: "Local" },
];

const TEMPLATE = `[
  {
    "type": "command",
    "command": "echo hook fired"
  }
]`;

export default function HookEditorPage({ params }: { params: Promise<{ event: string }> }) {
  const { event: rawEvent } = use(params);
  const searchParams = useSearchParams();

  const isNew = rawEvent === "new";
  const event = isNew ? "" : decodeURIComponent(rawEvent);
  const scope = searchParams.get("scope") || "global";
  const filePath = searchParams.get("filePath") || "";
  const cwd = searchParams.get("cwd") || undefined;

  usePageHeader(isNew ? "New Hook" : event);

  const [selectedEvent, setSelectedEvent] = useState(event);
  const [selectedScope, setSelectedScope] = useState(scope);
  const [content, setContent] = useState(isNew ? TEMPLATE : "");
  const [savedContent, setSavedContent] = useState(isNew ? TEMPLATE : "");
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const dirty = content !== savedContent;

  useEffect(() => {
    if (isNew) return;
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);

    fetch(`/api/hooks?${params}`)
      .then((res) => res.json())
      .then((data: { hooks: Array<{ event: string; hooks: unknown[]; scope: string; filePath: string }> }) => {
        const match = data.hooks.find((h) => h.event === event && h.scope === scope);
        if (match) {
          const json = JSON.stringify(match.hooks, null, 2);
          setContent(json);
          setSavedContent(json);
        } else {
          setFeedback("Hook not found");
        }
      })
      .catch(() => setFeedback("Failed to load"))
      .finally(() => setLoading(false));
  }, [isNew, event, scope, cwd]);

  function resolveFilePath(): string {
    if (!isNew && filePath) return filePath;
    // Build path from scope
    if (selectedScope === "global") {
      // We can't call homedir() on client, but the API will validate
      // Send a sentinel and let the API resolve it
      return "__global__";
    }
    if (selectedScope === "project" && cwd) {
      return `${cwd}/.claude/settings.json`;
    }
    if (selectedScope === "project-local" && cwd) {
      return `${cwd}/.claude/settings.local.json`;
    }
    return "";
  }

  const save = useCallback(async () => {
    const ev = isNew ? selectedEvent : event;
    if (!ev) {
      setFeedback("Select an event");
      return;
    }

    let parsed: unknown[];
    try {
      parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) throw new Error("Must be an array");
    } catch (_err) {
      setFeedback("Invalid JSON: must be an array of hook objects");
      return;
    }

    setSaving(true);
    setFeedback(null);

    const fp = resolveFilePath();
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);

    try {
      const res = await fetch(`/api/hooks?${params}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: fp, event: ev, hooks: parsed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Save failed");
      }
      setSavedContent(content);
      setFeedback("Saved");
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [content, isNew, selectedEvent, event, cwd, resolveFilePath]);

  if (loading) {
    return (
      <div className="flex-1 min-h-0 p-4">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          {isNew ? (
            <div className="flex gap-2">
              <select
                value={selectedEvent}
                onChange={(e) => setSelectedEvent(e.target.value)}
                className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              >
                <option value="">Select event...</option>
                {HOOK_EVENTS.map((ev) => (
                  <option key={ev} value={ev}>
                    {ev}
                  </option>
                ))}
              </select>
              <select
                value={selectedScope}
                onChange={(e) => setSelectedScope(e.target.value)}
                className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              >
                {SCOPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value} disabled={opt.value !== "global" && !cwd}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-lg">{event}</span>
              <Badge variant="secondary">{scope === "global" ? "Global" : scope === "project" ? "Project" : "Local"}</Badge>
            </div>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const ta = document.createElement("textarea");
            ta.value = content;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button size="sm" onClick={save} disabled={saving || (!isNew && !dirty)}>
          <Save className="h-4 w-4 mr-1" />
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      {feedback && <p className={`text-sm ${feedback === "Saved" ? "text-green-600" : "text-destructive"}`}>{feedback}</p>}

      <CodeEditor value={content} onChange={setContent} language="json" onSave={save} className="flex-1" />
    </div>
  );
}
