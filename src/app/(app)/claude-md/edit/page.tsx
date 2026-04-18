"use client";

import { Check, Copy, Save } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { CodeEditor } from "@/components/code-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Scope = "user" | "project" | "project-hidden";

const SCOPE_LABELS: Record<Scope, { title: string; badge: string }> = {
  user: { title: "~/.claude/CLAUDE.md", badge: "Global" },
  project: { title: "CLAUDE.md", badge: "Project" },
  "project-hidden": { title: ".claude/CLAUDE.md", badge: "Project" },
};

export default function ClaudeMdEditPage() {
  const searchParams = useSearchParams();
  const scope = (searchParams.get("scope") || "user") as Scope;
  const cwd = searchParams.get("cwd") || undefined;
  const meta = SCOPE_LABELS[scope];

  usePageHeader("Edit CLAUDE.md");

  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const dirty = content !== savedContent;

  useEffect(() => {
    const params = new URLSearchParams({ scope });
    if (cwd) params.set("cwd", cwd);

    fetch(`/api/claude-md?${params}`)
      .then((res) => res.json())
      .then((data: { content: string; exists: boolean }) => {
        setContent(data.content);
        setSavedContent(data.content);
      })
      .catch(() => setFeedback("Failed to load"))
      .finally(() => setLoading(false));
  }, [scope, cwd]);

  const save = useCallback(async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/claude-md", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, content }),
      });
      if (!res.ok) throw new Error("Save failed");
      setSavedContent(content);
      setFeedback("Saved");
    } catch {
      setFeedback("Failed to save");
    } finally {
      setSaving(false);
    }
  }, [scope, cwd, content]);

  if (loading) {
    return (
      <div className="flex-1 min-h-0 p-4">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col p-4 gap-3">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="font-mono font-bold text-sm truncate">{meta.title}</span>
          <Badge variant="secondary" className="shrink-0">
            {meta.badge}
          </Badge>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {feedback && <p className={`text-sm ${feedback === "Saved" ? "text-green-600" : "text-destructive"}`}>{feedback}</p>}
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
          <Button size="sm" onClick={save} disabled={saving || !dirty}>
            <Save className="h-4 w-4 mr-1" />
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <CodeEditor
          value={content}
          onChange={(v) => {
            setContent(v);
            setFeedback(null);
          }}
          language="markdown"
          onSave={save}
          className="h-full [&_.cm-editor]:min-h-[400px]"
        />
      </div>
    </div>
  );
}
