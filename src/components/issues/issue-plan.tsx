"use client";

import { ClipboardList, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type PlanReviewActions, PlanReviewSurface } from "@/components/plan-review/plan-review-surface";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useHistoryModal } from "@/hooks/use-history-modal";
import { actorLabel } from "@/lib/issue-display";
import type { PlanDraft, PlanVersion } from "@/lib/plan-review/types";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types";

interface IssuePlanData {
  versions: PlanVersion[];
  draft: PlanDraft | null;
  reviewable: number | null;
  targets: { approve: string; sendBack: string };
}

const STATE: Record<string, { text: string; tone: string }> = {
  waiting: { text: "Waiting for your review", tone: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  approved: { text: "Approved", tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  changes_requested: { text: "Changes requested", tone: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  dismissed: { text: "Dismissed", tone: "bg-muted text-muted-foreground" },
};

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

async function send(
  url: string,
  method: string,
  body: unknown,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `Failed (${res.status})` };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Could not reach Cockpit" };
  }
}

/**
 * The plan attached to an issue: how the work will be done, kept apart from
 * the description. Shows where the plan stands and opens it for review, where
 * it is marked up and approved or sent back.
 *
 * `revision` changes whenever the issue was reloaded, so a plan an agent wrote
 * in the meantime is picked up with it.
 */
export function IssuePlanSection({
  issueKey,
  status,
  revision,
  onIssueChange,
}: {
  issueKey: string;
  status: string;
  revision: number;
  onIssueChange: (issue: Issue) => void;
}) {
  const base = `/api/issues/${encodeURIComponent(issueKey)}/plan`;
  const [plan, setPlan] = useState<IssuePlanData | null>(null);
  const { value: reviewing, open, close } = useHistoryModal<true>();

  const load = useCallback(async () => {
    try {
      const res = await fetch(base);
      if (res.ok) setPlan((await res.json()) as IssuePlanData);
    } catch {
      // Offline or mid-restart: what is on screen stays until the next try.
    }
  }, [base]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the trigger, not an input
  useEffect(() => {
    load();
  }, [load, revision]);

  if (!plan) return null;

  const newest = plan.versions[plan.versions.length - 1];
  const state = newest ? STATE[plan.reviewable !== null ? "waiting" : (newest.review?.outcome ?? "waiting")] : null;
  // The status says a person is the one holding the issue up.
  const awaited = plan.reviewable !== null && status === "Plan Review";

  return (
    <Card data-testid="issue-plan">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardList className="h-4 w-4 text-muted-foreground" />
          Plan
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!newest && (
          <p className="text-sm text-muted-foreground" data-testid="issue-plan-none">
            No plan yet. An agent writes one when it plans this issue.
          </p>
        )}

        {newest && state && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Version {newest.n}</span>
                <span className={cn("rounded px-1.5 py-0.5 text-xs", state.tone)} data-testid="issue-plan-state">
                  {state.text}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {newest.author ? `${actorLabel(newest.author)}, ` : ""}
                {when(newest.createdAt)}
              </div>
            </div>
            <Button variant={awaited ? "default" : "outline"} size="sm" onClick={() => open(true)} data-testid="issue-plan-open">
              {plan.reviewable !== null ? "Review plan" : "View plan"}
            </Button>
          </div>
        )}
      </CardContent>

      {reviewing &&
        createPortal(
          <IssuePlanModal issueKey={issueKey} plan={plan} onPlan={setPlan} onReload={load} onClose={close} onIssueChange={onIssueChange} />,
          document.body,
        )}
    </Card>
  );
}

function IssuePlanModal({
  issueKey,
  plan,
  onPlan,
  onReload,
  onClose,
  onIssueChange,
}: {
  issueKey: string;
  plan: IssuePlanData;
  onPlan: (plan: IssuePlanData) => void;
  onReload: () => Promise<void>;
  onClose: () => void;
  onIssueChange: (issue: Issue) => void;
}) {
  const base = `/api/issues/${encodeURIComponent(issueKey)}/plan`;
  const panelRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped when a decision was refused, so the surface starts again from what
  // the server holds: the markup it had cleared is still stored there.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Bubble phase, so an Escape the surface or one of its sheets has already
  // taken (to drop a selection, to close a composer) does not also close this.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const saveDraft = useCallback(
    (draft: Omit<PlanDraft, "hash"> | null) => {
      fetch(`${base}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft }),
        keepalive: true,
      }).catch(() => {});
    },
    [base],
  );

  const actions = useMemo<PlanReviewActions | undefined>(() => {
    if (plan.reviewable === null) return undefined;
    const decide = async (action: "approve" | "request_changes", input: Parameters<PlanReviewActions["requestChanges"]>[0]) => {
      setBusy(true);
      setError(null);
      const result = await send(`${base}/review`, "POST", {
        version: input.version.n,
        action,
        annotations: input.annotations,
        ...(input.editedText !== undefined ? { editedText: input.editedText } : {}),
      });
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        await onReload();
        setAttempt((n) => n + 1);
        return;
      }
      onPlan(result.data.plan as IssuePlanData);
      onIssueChange(result.data.issue as Issue);
      onClose();
    };
    return {
      approveOptions: [{ id: "approve", label: `Approve and move to ${plan.targets.approve}` }],
      sendLabel: "Send back",
      approve: (_option, input) => void decide("approve", input),
      requestChanges: (input) => void decide("request_changes", input),
    };
  }, [plan.reviewable, plan.targets.approve, base, onPlan, onIssueChange, onClose, onReload]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Plan for ${issueKey}`}
        className="flex h-full w-full flex-col overflow-hidden bg-background outline-none sm:h-[90dvh] sm:max-w-5xl sm:rounded-lg sm:border sm:shadow-lg"
        data-testid="issue-plan-modal"
      >
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
          <span className="font-mono text-sm text-muted-foreground">{issueKey}</span>
          <span className="text-sm font-medium">Plan</span>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <span className="flex-1" />
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} title="Close" data-testid="issue-plan-close">
            <X className="h-4 w-4" />
          </Button>
        </div>
        {error && (
          <div className="shrink-0 border-b bg-destructive/10 px-4 py-2 text-xs text-destructive" data-testid="issue-plan-error">
            {error}
          </div>
        )}
        <PlanReviewSurface
          key={attempt}
          versions={plan.versions}
          draft={plan.draft}
          reviewable={plan.reviewable}
          actions={actions}
          onDraftChange={saveDraft}
          singlePlan
        />
      </div>
    </div>
  );
}
