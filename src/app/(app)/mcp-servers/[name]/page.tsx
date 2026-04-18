"use client";

import { Save } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { KeyValueEditor } from "@/components/key-value-editor";
import { StringListEditor } from "@/components/string-list-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type TransportType = "stdio" | "http" | "sse";

interface McpServerFormState {
  type: TransportType;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
}

const EMPTY_FORM: McpServerFormState = {
  type: "stdio",
  command: "",
  args: [],
  env: {},
  url: "",
  headers: {},
};

const transportOptions: { value: TransportType; label: string }[] = [
  { value: "stdio", label: "stdio" },
  { value: "http", label: "http" },
  { value: "sse", label: "sse (deprecated)" },
];

function configToForm(config: Record<string, unknown>): McpServerFormState {
  const type = (config.type as TransportType) || (config.command ? "stdio" : config.url ? "http" : "stdio");
  return {
    type,
    command: (config.command as string) || "",
    args: (config.args as string[]) || [],
    env: (config.env as Record<string, string>) || {},
    url: (config.url as string) || "",
    headers: (config.headers as Record<string, string>) || {},
  };
}

function formToConfig(form: McpServerFormState): Record<string, unknown> {
  if (form.type === "stdio") {
    const config: Record<string, unknown> = { type: "stdio", command: form.command };
    if (form.args.length > 0) config.args = form.args;
    if (Object.keys(form.env).length > 0) config.env = form.env;
    return config;
  }
  const config: Record<string, unknown> = { type: form.type, url: form.url };
  if (Object.keys(form.headers).length > 0) config.headers = form.headers;
  return config;
}

function serialize(form: McpServerFormState): string {
  return JSON.stringify(formToConfig(form));
}

export default function McpServerEditorPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: rawName } = use(params);
  const searchParams = useSearchParams();
  const router = useRouter();

  const isNew = rawName === "new";
  const scope = (searchParams.get("scope") || "user") as "user" | "project";
  const cwd = searchParams.get("cwd") || undefined;

  usePageHeader(isNew ? "New MCP Server" : "Edit MCP Server");

  const [serverName, setServerName] = useState(isNew ? "" : decodeURIComponent(rawName));
  const [form, setForm] = useState<McpServerFormState>(EMPTY_FORM);
  const [savedSnapshot, setSavedSnapshot] = useState(serialize(EMPTY_FORM));
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const dirty = serialize(form) !== savedSnapshot;

  useEffect(() => {
    if (isNew) return;
    const params = new URLSearchParams({ scope });
    if (cwd) params.set("cwd", cwd);

    fetch(`/api/mcp-servers/${encodeURIComponent(rawName)}?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error("Not found");
        return res.json();
      })
      .then((data: { config: Record<string, unknown> }) => {
        const loaded = configToForm(data.config);
        setForm(loaded);
        setSavedSnapshot(serialize(loaded));
      })
      .catch(() => {
        setFeedback("Failed to load server");
      })
      .finally(() => setLoading(false));
  }, [isNew, rawName, scope, cwd]);

  const save = useCallback(async () => {
    const name = serverName.trim();
    if (!name) {
      setFeedback("Name is required");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      setFeedback("Name can only contain letters, numbers, hyphens, and underscores");
      return;
    }

    if (form.type === "stdio" && !form.command.trim()) {
      setFeedback("Command is required for stdio transport");
      return;
    }
    if ((form.type === "http" || form.type === "sse") && !form.url.trim()) {
      setFeedback("URL is required for " + form.type + " transport");
      return;
    }

    setSaving(true);
    setFeedback(null);

    try {
      const res = await fetch(`/api/mcp-servers/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, config: formToConfig(form) }),
      });
      if (!res.ok) throw new Error("Save failed");

      setSavedSnapshot(serialize(form));
      setFeedback("Saved");

      if (isNew) {
        const params = new URLSearchParams({ scope });
        if (cwd) params.set("cwd", cwd);
        router.replace(`/mcp-servers/${encodeURIComponent(name)}?${params}`);
      }
    } catch {
      setFeedback("Failed to save");
    } finally {
      setSaving(false);
    }
  }, [serverName, form, scope, cwd, isNew, router]);

  function updateForm(patch: Partial<McpServerFormState>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

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
            <Input placeholder="server-name" value={serverName} onChange={(e) => setServerName(e.target.value)} className="font-mono" />
          ) : (
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-lg">{serverName}</span>
              <Badge variant="secondary">{scope === "user" ? "Global" : "Project"}</Badge>
            </div>
          )}
        </div>
        <Button size="sm" onClick={save} disabled={saving || (!isNew && !dirty)}>
          <Save className="h-4 w-4 mr-1" />
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      {feedback && <p className={`text-sm ${feedback === "Saved" ? "text-green-600" : "text-destructive"}`}>{feedback}</p>}

      <div className="space-y-4">
        <div>
          <label className="text-sm font-medium mb-1.5 block">Transport</label>
          <div className="flex gap-1">
            {transportOptions.map((opt) => (
              <Button
                key={opt.value}
                variant={form.type === opt.value ? "default" : "outline"}
                size="sm"
                onClick={() => updateForm({ type: opt.value })}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </div>

        {form.type === "stdio" && (
          <>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Command</label>
              <Input
                placeholder="node"
                value={form.command}
                onChange={(e) => updateForm({ command: e.target.value })}
                className="font-mono"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Arguments</label>
              <StringListEditor value={form.args} onChange={(args) => updateForm({ args })} placeholder="argument" />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Environment Variables</label>
              <KeyValueEditor value={form.env} onChange={(env) => updateForm({ env })} keyPlaceholder="VARIABLE" valuePlaceholder="value" />
            </div>
          </>
        )}

        {(form.type === "http" || form.type === "sse") && (
          <>
            <div>
              <label className="text-sm font-medium mb-1.5 block">URL</label>
              <Input
                placeholder="https://example.com/mcp"
                value={form.url}
                onChange={(e) => updateForm({ url: e.target.value })}
                className="font-mono"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Headers</label>
              <KeyValueEditor
                value={form.headers}
                onChange={(headers) => updateForm({ headers })}
                keyPlaceholder="Header-Name"
                valuePlaceholder="value"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
