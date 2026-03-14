"use client";

import { useState, useEffect, useCallback, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { usePageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CodeEditor } from "@/components/code-editor";
import { Save } from "lucide-react";

const TEMPLATE = `---
description: What this skill does
---

Your skill instructions here. Use $ARGUMENTS for user input.
`;

export default function SkillEditorPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name: rawName } = use(params);
  const searchParams = useSearchParams();
  const router = useRouter();

  const isNew = rawName === "new";
  const scope = (searchParams.get("scope") || "user") as "user" | "project";
  const cwd = searchParams.get("cwd") || undefined;

  usePageHeader(isNew ? "New Skill" : "Edit Skill", true);

  const [skillName, setSkillName] = useState(isNew ? "" : decodeURIComponent(rawName));
  const [content, setContent] = useState(isNew ? TEMPLATE : "");
  const [savedContent, setSavedContent] = useState(isNew ? TEMPLATE : "");
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const dirty = content !== savedContent;

  useEffect(() => {
    if (isNew) return;
    const params = new URLSearchParams({ scope });
    if (cwd) params.set("cwd", cwd);

    fetch(`/api/skills/${encodeURIComponent(rawName)}?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error("Not found");
        return res.json();
      })
      .then((data: { content: string }) => {
        setContent(data.content);
        setSavedContent(data.content);
      })
      .catch(() => {
        setFeedback("Failed to load skill");
      })
      .finally(() => setLoading(false));
  }, [isNew, rawName, scope, cwd]);

  const save = useCallback(async () => {
    const name = skillName.trim();
    if (!name) {
      setFeedback("Name is required");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      setFeedback("Name can only contain letters, numbers, hyphens, and underscores");
      return;
    }

    setSaving(true);
    setFeedback(null);

    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, content }),
      });
      if (!res.ok) throw new Error("Save failed");

      setSavedContent(content);
      setFeedback("Saved");

      if (isNew) {
        const params = new URLSearchParams({ scope });
        if (cwd) params.set("cwd", cwd);
        router.replace(`/skills/${encodeURIComponent(name)}?${params}`);
      }
    } catch {
      setFeedback("Failed to save");
    } finally {
      setSaving(false);
    }
  }, [skillName, content, scope, cwd, isNew, router]);

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
            <Input
              placeholder="skill-name"
              value={skillName}
              onChange={(e) => setSkillName(e.target.value)}
              className="font-mono"
            />
          ) : (
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-lg">{skillName}</span>
              <Badge variant="secondary">
                {scope === "user" ? "Global" : "Project"}
              </Badge>
            </div>
          )}
        </div>
        <Button size="sm" onClick={save} disabled={saving || (!isNew && !dirty)}>
          <Save className="h-4 w-4 mr-1" />
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      {feedback && (
        <p className={`text-sm ${feedback === "Saved" ? "text-green-600" : "text-destructive"}`}>
          {feedback}
        </p>
      )}

      <CodeEditor
        value={content}
        onChange={setContent}
        language="markdown"
        onSave={save}
        className="flex-1"
      />
    </div>
  );
}
