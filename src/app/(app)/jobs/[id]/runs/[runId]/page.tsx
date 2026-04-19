"use client";

import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { JobRun, JobRunToolUse } from "@/types";

function statusBadge(status: string) {
  switch (status) {
    case "success":
      return <Badge className="bg-green-600 text-white">Success</Badge>;
    case "failure":
      return <Badge variant="destructive">Failed</Badge>;
    case "timeout":
      return <Badge className="bg-yellow-600 text-white">Timeout</Badge>;
    case "running":
      return <Badge className="bg-blue-600 text-white">Running</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function ToolEntry({ tool }: { tool: JobRunToolUse }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border rounded-md">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="font-mono font-medium">{tool.name}</span>
        {tool.permitted !== undefined && (
          <Badge variant={tool.permitted ? "secondary" : "destructive"} className="text-[10px]">
            {tool.permitted ? "Allowed" : "Denied"}
          </Badge>
        )}
        {tool.durationMs != null && <span className="text-xs text-muted-foreground ml-auto">{tool.durationMs}ms</span>}
      </button>
      {expanded && (
        <div className="border-t px-3 py-2 space-y-2">
          {tool.input && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Input</p>
              <pre className="text-xs bg-muted rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap">{tool.input}</pre>
            </div>
          )}
          {tool.output && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Output</p>
              <pre className="text-xs bg-muted rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap">{tool.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function RunDetailPage() {
  const params = useParams();
  const jobId = params.id as string;
  const runId = params.runId as string;
  const router = useRouter();

  usePageHeader("Run Detail");

  const [run, setRun] = useState<JobRun | null>(null);
  const [loading, setLoading] = useState(true);

  const loadRun = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/runs/${runId}`);
      if (!res.ok) {
        router.push(`/jobs/${jobId}`);
        return;
      }
      const data = await res.json();
      setRun(data.run);
    } finally {
      setLoading(false);
    }
  }, [jobId, runId, router]);

  useEffect(() => {
    loadRun();
  }, [loadRun]);

  if (loading || !run) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => router.push(`/jobs/${jobId}`)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            Run Summary
            {statusBadge(run.status)}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-muted-foreground">Started:</span> {new Date(run.startedAt).toLocaleString()}
            </div>
            {run.completedAt && (
              <div>
                <span className="text-muted-foreground">Completed:</span> {new Date(run.completedAt).toLocaleString()}
              </div>
            )}
            {run.durationMs != null && (
              <div>
                <span className="text-muted-foreground">Duration:</span> {Math.round(run.durationMs / 1000)}s
              </div>
            )}
            <div>
              <span className="text-muted-foreground">Messages:</span> {run.messageCount}
            </div>
          </div>
          {run.error && <div className="mt-2 p-2 rounded bg-destructive/10 text-destructive text-xs">{run.error}</div>}
          <div className="mt-2">
            <span className="text-muted-foreground">Prompt:</span>
            <pre className="mt-1 text-xs bg-muted rounded p-2 whitespace-pre-wrap">{run.prompt}</pre>
          </div>
          <div>
            <span className="text-muted-foreground">Working Directory:</span> <span className="font-mono text-xs">{run.cwd}</span>
          </div>
          <div className="pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/sessions/${run.sessionId}?cwd=${encodeURIComponent(run.cwd)}`)}
            >
              <ExternalLink className="h-3 w-3 mr-1" />
              View Full Transcript
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tool Usage ({run.toolsUsed.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {run.toolsUsed.length === 0 && <p className="text-sm text-muted-foreground">No tool invocations recorded.</p>}
          <div className="space-y-1">
            {run.toolsUsed.map((tool, i) => (
              <ToolEntry key={`${tool.name}-${tool.timestamp}-${i}`} tool={tool} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
