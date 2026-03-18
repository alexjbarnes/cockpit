"use client";

import { useRouter } from "next/navigation";
import { usePageHeader } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useHooks } from "@/hooks/use-hooks";

const SCOPE_LABELS: Record<string, string> = {
  global: "Global",
  project: "Project",
  "project-local": "Local",
};

const BLOCKING_EVENTS = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "Stop",
  "SubagentStop",
]);

export default function HooksPage() {
  usePageHeader("Hooks", true);

  const cwd = typeof localStorage !== "undefined"
    ? localStorage.getItem("aperture-agents-cwd") || undefined
    : undefined;

  const { hooks, loading } = useHooks(cwd);
  const router = useRouter();

  function handleClick(event: string, scope: string, filePath: string) {
    const params = new URLSearchParams({ scope, filePath });
    if (cwd) params.set("cwd", cwd);
    router.push(`/hooks/${encodeURIComponent(event)}?${params}`);
  }

  function handleNew() {
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    router.push(`/hooks/new?${params}`);
  }

  // Group by scope
  const grouped: Record<string, typeof hooks> = {};
  for (const h of hooks) {
    const key = h.scope;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(h);
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div />
        <button
          className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          onClick={handleNew}
        >
          New Hook
        </button>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading hooks...</p>}

      {!loading && hooks.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No hooks configured. Hooks let you run commands, HTTP requests, or prompts at key points in the agent lifecycle.
        </p>
      )}

      {Object.entries(grouped).map(([scope, items]) => (
        <Card key={scope}>
          <CardHeader>
            <CardTitle className="text-base">{SCOPE_LABELS[scope] || scope}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {items.map((item) => (
              <button
                key={`${item.event}-${item.scope}`}
                type="button"
                className="flex w-full items-center gap-3 rounded px-2 py-2 hover:bg-muted transition-colors text-left"
                onClick={() => handleClick(item.event, item.scope, item.filePath)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-sm">{item.event}</span>
                    {BLOCKING_EVENTS.has(item.event) && (
                      <Badge variant="outline" className="text-[10px]">can block</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {item.hooks.length} hook{item.hooks.length !== 1 ? "s" : ""}
                    {" \u2014 "}
                    {item.hooks.map((h) => h.type).join(", ")}
                  </p>
                </div>
              </button>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
