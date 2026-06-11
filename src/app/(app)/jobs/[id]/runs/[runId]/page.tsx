"use client";

import { ArrowLeft, ChevronDown, ChevronRight, ChevronUp, FileText, Loader2, MessageSquare, Square, X } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { MessageBubble } from "@/components/message-bubble";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ChatMessage, JobRun, JobRunToolUse } from "@/types";

const MAX_PROMPT_LINES = 8;

function CollapsiblePrompt({ prompt }: { prompt: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = prompt.split("\n");
  const needsCollapse = lines.length > MAX_PROMPT_LINES;
  const displayText = needsCollapse && !expanded ? lines.slice(0, MAX_PROMPT_LINES).join("\n") : prompt;

  return (
    <div className="mt-2">
      <span className="text-muted-foreground">Prompt:</span>
      <pre className="mt-1 text-xs bg-muted rounded p-2 whitespace-pre-wrap">{displayText}</pre>
      {needsCollapse && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-1 transition-colors"
        >
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {expanded ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

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
    case "stopped":
      return <Badge variant="secondary">Stopped</Badge>;
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
        <span className="font-mono font-medium truncate min-w-0">{tool.name}</span>
        {tool.permitted !== undefined && (
          <Badge variant={tool.permitted ? "secondary" : "destructive"} className="text-[10px]">
            {tool.permitted ? "Allowed" : "Denied"}
          </Badge>
        )}
        {tool.durationMs != null && <span className="text-xs text-muted-foreground ml-auto shrink-0">{tool.durationMs}ms</span>}
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

function TranscriptModal({ jobId, runId, onClose }: { jobId: string; runId: string; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const expandedToolIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    fetch(`/api/jobs/${jobId}/runs/${runId}/transcript`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load transcript");
        return res.json();
      })
      .then((data) => {
        setMessages(data.messages);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [jobId, runId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={handleOverlayClick}>
      <Card className="w-full max-w-3xl flex flex-col" style={{ maxHeight: "calc(100dvh - 2rem)" }}>
        <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
          <span className="text-sm font-medium text-muted-foreground">Run transcript</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {loading && (
            <div className="flex justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {error && <div className="text-center text-sm text-red-500 py-12">{error}</div>}
          {!loading && messages.length === 0 && !error && (
            <div className="text-center text-sm text-muted-foreground py-12">No transcript found for this run.</div>
          )}
          {!loading &&
            messages.map((msg) => (
              <div key={msg.id}>
                <MessageBubble message={msg} expandedToolIds={expandedToolIds} />
              </div>
            ))}
        </div>
      </Card>
    </div>
  );
}

export default function RunDetailPage() {
  const params = useParams();
  const jobId = params.id as string;
  const runId = params.runId as string;
  const router = useRouter();

  usePageHeader("Run Detail", { hideActions: true });

  const [run, setRun] = useState<JobRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [showTranscript, setShowTranscript] = useState(false);
  const [stopping, setStopping] = useState(false);

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

  async function handleStop() {
    setStopping(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/stop`, { method: "POST" });
      if (res.ok) {
        await loadRun();
      }
      setStopping(false);
    } catch {
      setStopping(false);
    }
  }

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
          <CollapsiblePrompt prompt={run.prompt} />
          <div>
            <span className="text-muted-foreground">Working Directory:</span> <span className="font-mono text-xs break-all">{run.cwd}</span>
          </div>
          <div className="pt-2 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowTranscript(true)}>
              <FileText className="h-3 w-3 mr-1" />
              View Transcript
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/sessions/${run.sessionId}?cwd=${encodeURIComponent(run.cwd)}`)}
            >
              <MessageSquare className="h-3 w-3 mr-1" />
              Continue Session
            </Button>
            {run.status === "running" && (
              <Button variant="destructive" size="sm" onClick={handleStop} disabled={stopping}>
                {stopping ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Square className="h-3 w-3 mr-1" />}
                Stop Now
              </Button>
            )}
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

      {showTranscript && <TranscriptModal jobId={jobId} runId={runId} onClose={() => setShowTranscript(false)} />}
    </div>
  );
}
