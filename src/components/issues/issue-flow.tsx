"use client";

import { AlertTriangle, Bot, Clock, Hand, Loader2, User } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  FLOW_LABEL,
  type FlowState,
  type IssueFlow,
  infoForStatus,
  issueFlows,
  statusTag,
  statusTagTitle,
  type WorkflowActivityView,
} from "@/lib/workflow-display";

/** How often the page asks what the workflows are doing, while one is on. */
const ACTIVITY_POLL_MS = 5000;

interface Flows {
  activity: WorkflowActivityView | null;
  flows: Map<string, IssueFlow>;
  reload: () => void;
}

const FlowsContext = createContext<Flows>({ activity: null, flows: new Map(), reload: () => {} });

/**
 * What the workflows are doing, for everything inside: the bar above a list
 * and the mark on each issue. Asks only while workflows are on, and only
 * while the page is the one being looked at.
 */
export function WorkflowFlowsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [activity, setActivity] = useState<WorkflowActivityView | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/workflows/activity");
      if (res.ok) setActivity((await res.json()) as WorkflowActivityView);
    } catch {
      // Offline or mid-restart: what is on screen stays until the next try.
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setActivity(null);
      return;
    }
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, ACTIVITY_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, load]);

  const value = useMemo(() => ({ activity, flows: issueFlows(activity), reload: () => void load() }), [activity, load]);
  return <FlowsContext.Provider value={value}>{children}</FlowsContext.Provider>;
}

export function useWorkflowFlows(): Flows {
  return useContext(FlowsContext);
}

const TONE: Record<FlowState, string> = {
  attention: "bg-red-500/15 text-red-700 dark:text-red-300",
  yours: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  running: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  queued: "bg-muted text-muted-foreground",
};

function FlowIcon({ state, className }: { state: FlowState; className?: string }) {
  if (state === "running") return <Loader2 className={cn("animate-spin", className)} />;
  if (state === "attention") return <AlertTriangle className={className} />;
  if (state === "yours") return <Hand className={className} />;
  return <Clock className={className} />;
}

/**
 * What happens to issues at a status, beside the status's own heading: it is
 * a queue for an agent, an agent runs a skill there, or it waits for you.
 * This is what ties a board's columns to the workflow. Nothing for a status
 * where nothing happens.
 */
export function StatusStageTag({ status, projectId, className }: { status: string; projectId?: string; className?: string }) {
  const info = infoForStatus(useContext(FlowsContext).activity?.statuses, status, projectId);
  if (!info) return null;
  const Icon = info.kind === "human" ? User : info.kind === "queue" ? Clock : Bot;
  return (
    <span
      title={statusTagTitle(info)}
      data-testid={`status-stage-${status}`}
      data-kind={info.kind}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-normal",
        info.kind === "human"
          ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : info.missing
            ? "border-amber-500/50 text-amber-700 dark:text-amber-300"
            : "text-muted-foreground",
        info.kind === "agent" && "font-mono",
        className,
      )}
    >
      {info.missing ? <AlertTriangle className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
      {statusTag(info)}
    </span>
  );
}

/** The mark on an issue in a list or on the board: what its workflow is doing
 *  with it. Nothing for an issue no workflow is holding. */
export function IssueFlowBadge({ issueKey, className }: { issueKey: string; className?: string }) {
  const flow = useContext(FlowsContext).flows.get(issueKey);
  if (!flow) return null;
  const what = flow.skill ? `${flow.skill}, in ${flow.status}` : flow.status;
  const title = flow.state === "attention" ? `Held in ${flow.status}: ${flow.reason ?? ""}` : `${FLOW_LABEL[flow.state]}: ${what}`;
  return (
    <span
      title={title}
      data-testid={`issue-flow-${issueKey}`}
      data-flow={flow.state}
      className={cn("inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium", TONE[flow.state], className)}
    >
      <FlowIcon state={flow.state} className="h-3 w-3" />
      {FLOW_LABEL[flow.state]}
    </span>
  );
}
