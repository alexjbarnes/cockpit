"use client";

import { AlertTriangle, Bot, Check, ChevronRight, Eye, Loader2, RotateCcw, Square, User, Workflow as WorkflowIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SessionPeekModal } from "@/components/session-peek-modal";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusName } from "@/components/workflows/status-select";
import { cn } from "@/lib/utils";
import { formatDuration, queuesFor, RUN_STATUS_LABEL, stopStates, stopSummary, trackPosition, trackStops } from "@/lib/workflow-display";
import type { IssueAttention, WorkflowRun, WorkflowStatusRule } from "@/types";

/** How often an issue with a run going, or waiting for one, is looked at again. */
const POLL_MS = 4000;

interface IssueWorkflowData {
  workflow: { enabled: boolean; statuses: Record<string, WorkflowStatusRule> } | null;
  /** The project's statuses, in the order its board shows them. */
  order?: string[];
  active?: boolean;
  liveRunId?: string | null;
  attention?: IssueAttention | null;
  /** It sits where an agent works, which has a queue, with nothing working on it. */
  idle?: boolean;
  /** Statuses whose agent cannot start: its skill is not in the repo. */
  missingSkills?: string[];
  runs?: (Omit<WorkflowRun, "toolsUsed"> & { toolCount: number })[];
}

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** A count of seconds that keeps going while something is running. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="tabular-nums">{formatDuration(now - since)}</span>;
}

const STATE_WORD = { done: "Done", current: "Here now", ahead: "Still to come" } as const;

/**
 * Where an issue is in its project's workflow: a track of the statuses where
 * an agent works or a person decides, what is happening at the one it is at,
 * and what has run. A status that waits for a person shows its choices as
 * buttons; one an agent works shows the run, with a way to watch it, stop it,
 * or start it again when it was held.
 *
 * `onChanged` is called when something moved under the page (a run started or
 * ended, the issue was held), so the page reads the issue again.
 */
export function IssueWorkflowSection({
  issueKey,
  status,
  revision,
  onMove,
  onChanged,
}: {
  issueKey: string;
  status: string;
  revision: number;
  onMove: (status: string) => Promise<void> | void;
  onChanged: () => void;
}) {
  const base = `/api/issues/${encodeURIComponent(issueKey)}`;
  const [data, setData] = useState<IssueWorkflowData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  // The session behind "Peek": its latest messages, over the issue.
  const [peek, setPeek] = useState<{ sessionId: string; cwd: string; label: string } | null>(null);
  const seen = useRef("");
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${base}/workflow`);
      if (!res.ok) return;
      const next = (await res.json()) as IssueWorkflowData;
      setData(next);
      // What a run starting, ending or being held changes. When it differs
      // from the last look, the issue itself has moved too.
      const mark = `${next.liveRunId ?? ""}|${next.runs?.length ?? 0}|${next.attention?.at ?? ""}|${next.runs?.at(-1)?.status ?? ""}`;
      if (seen.current && seen.current !== mark) changed.current();
      seen.current = mark;
    } catch {
      // Offline or mid-restart: what is on screen stays until the next try.
    }
  }, [base]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and status are triggers, not inputs
  useEffect(() => {
    void load();
  }, [load, revision, status]);

  const rules = data?.workflow?.statuses ?? {};
  const rule = Object.hasOwn(rules, status) ? rules[status] : undefined;
  const live = data?.runs?.find((r) => r.id === data.liveRunId);
  // In a queue, or where an agent works with no queue in front: an agent takes it when one is free.
  const waitingForAgent = rule?.kind === "queue" || (rule?.kind === "agent" && !data?.idle);
  // Something is about to change without anyone touching the page: a run is
  // going, or the issue is waiting for one to start.
  const moving = !!data?.active && (!!live || (waitingForAgent && !data.attention));
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [moving, load]);

  async function act(action: "retry" | "stop") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) setError((await res.json().catch(() => ({}))).error || "That did not work");
    } catch {
      setError("Could not reach Cockpit");
    }
    setBusy(null);
    await load();
    changed.current();
  }

  async function move(to: string) {
    setBusy(to);
    setError(null);
    await onMove(to);
    setBusy(null);
    await load();
  }

  if (!data?.workflow) return null;
  const { workflow } = data;
  const stops = trackStops(rules, data.order ?? []);
  const at = trackPosition(stops, rules, status);
  const states = stopStates(stops.length, at);
  const runs = data.runs ?? [];
  const heldRun = data.attention?.runId ? runs.find((r) => r.id === data.attention?.runId) : undefined;
  const finished = status === "Done" || status === "Cancelled";
  // The status the agent works this issue in, and the skill it runs there.
  const workStatus = rule?.kind === "queue" ? rule.to : status;
  const agentRule = Object.hasOwn(rules, workStatus) && rules[workStatus].kind === "agent" ? rules[workStatus] : undefined;
  const skill = agentRule?.kind === "agent" ? agentRule.skill : undefined;
  const blocked = (data.missingSkills ?? []).includes(workStatus);
  // Where an issue goes to start: the queue of the first stop, or the stop itself.
  const first = stops[0];
  const entry = first ? (queuesFor(rules, first.status)[0] ?? first.status) : undefined;
  const shown = picked !== null && stops[picked] ? picked : null;
  const tone = data.attention ? "held" : stops[at]?.kind === "human" ? "yours" : "agent";

  return (
    <>
      <Card data-testid="issue-workflow">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <WorkflowIcon className="h-4 w-4 text-muted-foreground" />
            Workflow
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* One bar per status where something happens to the issue. Pressing one says what it is. */}
          {stops.length > 0 && (
            <div>
              <ol className="flex gap-1" data-testid="workflow-track">
                {stops.map((stop, i) => {
                  const state = states[i];
                  const current = state === "current";
                  const Icon = state === "done" ? Check : current && data.attention ? AlertTriangle : stop.kind === "agent" ? Bot : User;
                  return (
                    <li key={stop.status} className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => setPicked(shown === i ? null : i)}
                        aria-pressed={shown === i}
                        aria-label={`${stop.status}: ${STATE_WORD[state]}. ${stopSummary(stop)}`}
                        data-testid={`workflow-stop-${stop.status}`}
                        data-position={state}
                        className={cn(
                          "flex w-full flex-col items-center gap-1 rounded-t-md px-0.5 pt-1 text-muted-foreground",
                          shown === i && "bg-muted",
                          state === "done" && "text-foreground",
                          current && "font-semibold",
                          current && tone === "held" && "text-red-600 dark:text-red-400",
                          current && tone === "yours" && "text-amber-700 dark:text-amber-300",
                          current && tone === "agent" && "text-blue-600 dark:text-blue-400",
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        <span
                          className={cn(
                            "h-1.5 w-full rounded-full",
                            state === "ahead" ? "bg-muted" : "bg-current",
                            state === "done" && "opacity-50",
                          )}
                        />
                        <span className="hidden max-w-full truncate text-[11px] sm:block">{stop.status}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
              {/* On a phone the names do not fit under the bars, so one line says where it is. */}
              <div
                className={cn("mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm", shown === null && "sm:hidden")}
                data-testid="workflow-track-caption"
              >
                {shown !== null ? (
                  <>
                    <StatusName name={stops[shown].status} className="font-medium" />
                    <span className="text-xs text-muted-foreground">
                      {shown + 1} of {stops.length}. {STATE_WORD[states[shown]]}. {stopSummary(stops[shown])}.
                    </span>
                  </>
                ) : at === -1 ? (
                  <>
                    <span className="text-xs text-muted-foreground">{finished ? "Finished." : "Not started. First stop is"}</span>
                    {!finished && <StatusName name={stops[0].status} className="font-medium" />}
                  </>
                ) : (
                  <>
                    <StatusName name={stops[at].status} className="font-medium" />
                    <span className="text-xs text-muted-foreground">
                      {at + 1} of {stops.length}
                      {stops[at + 1] ? `, then ${stops[at + 1].status}` : ""}
                    </span>
                  </>
                )}
              </div>
            </div>
          )}

          {!data.active && (
            <p className="text-xs text-muted-foreground" data-testid="workflow-inactive">
              {workflow.enabled
                ? "Workflows are switched off, so nothing starts by itself."
                : "This project's workflow is switched off, so nothing starts by itself."}
            </p>
          )}

          {data.attention && (
            <div className="space-y-2 rounded-md border border-red-500/40 bg-red-500/10 p-3" data-testid="workflow-attention">
              <div className="flex items-start gap-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">Held at {data.attention.workStatus ?? status}</div>
                  <p className="mt-0.5 text-muted-foreground [overflow-wrap:anywhere]">{data.attention.reason}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => act("retry")} disabled={busy !== null} data-testid="workflow-retry">
                  {busy === "retry" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1 h-3.5 w-3.5" />}
                  Run it again
                </Button>
                {heldRun?.sessionId && (
                  <button
                    type="button"
                    onClick={() => setPeek({ sessionId: heldRun.sessionId, cwd: heldRun.cwd, label: heldRun.skill ?? "the session" })}
                    className="text-xs underline-offset-2 hover:underline"
                    data-testid="workflow-peek-held"
                  >
                    See what the session did
                  </button>
                )}
              </div>
            </div>
          )}

          {live && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-muted/40 p-3" data-testid="workflow-running">
              {/* On a phone the text takes the row and the actions sit under it:
                  sharing the row left it one word wide beside two buttons. */}
              <div className="flex min-w-0 flex-1 basis-full items-start gap-3 sm:basis-0">
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />
                <div className="min-w-0 text-sm" data-testid="workflow-running-text">
                  An agent is running <span className="font-mono text-[13px]">{live.skill}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    for <Elapsed since={live.startedAt} />
                    {live.model ? `, on ${live.model}` : ""}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPeek({ sessionId: live.sessionId, cwd: live.cwd, label: live.skill })}
                  data-testid="workflow-peek"
                >
                  <Eye className="mr-1 h-3.5 w-3.5" />
                  Peek
                </Button>
                <Button variant="outline" size="sm" onClick={() => act("stop")} disabled={busy !== null} data-testid="workflow-stop">
                  {busy === "stop" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Square className="mr-1 h-3 w-3" />}
                  Stop
                </Button>
              </div>
            </div>
          )}

          {!live && !data.attention && waitingForAgent && data.active && blocked && (
            <p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300" data-testid="workflow-blocked">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Nothing can start: there is no <span className="font-mono text-[13px]">{skill}</span> skill in the project's repo.
              </span>
            </p>
          )}

          {!live && !data.attention && waitingForAgent && data.active && !blocked && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="workflow-queued">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>
                An agent runs <span className="font-mono text-[13px]">{skill}</span> on this when one is free.
              </span>
            </p>
          )}

          {data.idle && (
            <div className="flex flex-wrap items-center gap-3" data-testid="workflow-idle">
              <p className="min-w-0 flex-1 text-sm text-muted-foreground">Nothing is working on this.</p>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act("retry")} data-testid="workflow-queue">
                {busy === "retry" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                Queue it for an agent
              </Button>
            </div>
          )}

          {rule?.kind === "human" && (
            <div className="space-y-2" data-testid="workflow-yours">
              <p className="text-sm">
                <span className="font-medium">{status}</span> is yours.
                {rule.review === "plan" && <span className="text-muted-foreground"> Review the plan above, or move it yourself:</span>}
              </p>
              <div className="flex flex-wrap gap-2">
                {rule.next.map((t, i) => (
                  <Button
                    key={t.status}
                    size="sm"
                    variant={i === 0 && rule.review !== "plan" ? "default" : "outline"}
                    disabled={busy !== null}
                    onClick={() => move(t.status)}
                    title={`Move to ${t.status}`}
                    data-testid={`workflow-move-${t.status}`}
                  >
                    {busy === t.status ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                    {t.label}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {!rule && !finished && entry && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="min-w-0 flex-1 text-sm text-muted-foreground">Nothing happens at {status}.</p>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => move(entry)} data-testid="workflow-start">
                {busy === entry ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                Move to {entry}
              </Button>
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          {runs.length > 0 && (
            <div className="border-t pt-2">
              <button
                type="button"
                onClick={() => setShowRuns((v) => !v)}
                aria-expanded={showRuns}
                className="flex w-full items-center gap-1 py-1 text-xs text-muted-foreground hover:text-foreground"
                data-testid="workflow-runs-toggle"
              >
                <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", showRuns && "rotate-90")} />
                {runs.length} run{runs.length === 1 ? "" : "s"}
              </button>
              {showRuns && (
                <div className="mt-1 space-y-0.5" data-testid="workflow-runs">
                  {[...runs].reverse().map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setPeek({ sessionId: r.sessionId, cwd: r.cwd, label: r.skill ?? r.workStatus ?? "the session" })}
                      className="flex w-full flex-wrap items-baseline gap-x-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/60"
                    >
                      {/* A run from before workflows ran skills carries a stage's name instead. */}
                      <span className="font-medium">{r.workStatus ?? (r as { stageName?: string }).stageName}</span>
                      {r.skill && <span className="font-mono text-muted-foreground">{r.skill}</span>}
                      <span
                        className={cn(
                          r.status === "success" && "text-emerald-600 dark:text-emerald-400",
                          (r.status === "failure" || r.status === "timeout") && "text-red-600 dark:text-red-400",
                          (r.status === "stopped" || r.status === "running") && "text-muted-foreground",
                        )}
                      >
                        {RUN_STATUS_LABEL[r.status]}
                      </span>
                      {r.to && <span className="text-muted-foreground">to {r.to}</span>}
                      <span className="flex-1" />
                      <span className="text-muted-foreground">
                        {r.durationMs !== undefined ? `${formatDuration(r.durationMs)}, ` : ""}
                        {when(r.startedAt)}
                      </span>
                      {r.error && r.status !== "success" && (
                        <span className="w-full text-muted-foreground [overflow-wrap:anywhere]">{r.error}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      {peek && <SessionPeekModal sessionId={peek.sessionId} cwd={peek.cwd} label={peek.label} running onClose={() => setPeek(null)} />}
    </>
  );
}
