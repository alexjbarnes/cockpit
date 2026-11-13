"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlanBridge } from "@/contexts/plan-bridge";
import { approvePlan, dismissPlan, type PlanAnswerDeps, planApprovalOptions, requestPlanChanges } from "@/lib/plan-review/approval";
import { planEditDiff } from "@/lib/plan-review/diff";
import type { PlanDraft, PlanVersion } from "@/lib/plan-review/types";
import { type PlanReviewActions, PlanReviewSurface } from "./plan-review-surface";

interface SessionPlan {
  versions: PlanVersion[];
  draft: PlanDraft | null;
}

const EMPTY: SessionPlan = { versions: [], draft: null };

/**
 * A session's Plan tab: every plan the session has proposed, the one waiting
 * for an answer open for review. The versions and the draft come from the
 * server; the waiting plan and the means to answer it come from the chat,
 * through the plan bridge.
 */
export function SessionPlanView({ sessionId, active }: { sessionId: string; active: boolean }) {
  const bridge = usePlanBridge();
  const pending = bridge?.pending ?? null;
  const [plan, setPlan] = useState<SessionPlan>(EMPTY);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/plan-review`);
      if (!res.ok) return;
      const body = (await res.json()) as { versions?: PlanVersion[]; draft?: PlanDraft | null };
      setPlan({ versions: body.versions ?? [], draft: body.draft ?? null });
    } catch {
      // Offline or mid-restart: what is on screen stays until the next try.
    } finally {
      setLoaded(true);
    }
  }, [sessionId]);

  // Reload when the waiting plan changes (a new one arrived, or it was
  // answered and its review is now on record), when the tab is shown, and
  // when the window comes back, which is when a draft from another device
  // would have landed.
  const pendingId = pending?.requestId ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingId and active are the triggers, not inputs
  useEffect(() => {
    const timer = setTimeout(load, pendingId ? 0 : 250);
    return () => clearTimeout(timer);
  }, [load, pendingId, active]);
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "visible") load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [load]);

  // The waiting plan is shown even when the store has not caught up, or could
  // not keep it: a plan that cannot be stored must still be answerable.
  const versions = useMemo(() => {
    if (!pending?.planContent) return plan.versions;
    const known = plan.versions.some((v) =>
      pending.planVersion !== undefined ? v.n === pending.planVersion : v.requestId === pending.requestId,
    );
    if (known) return plan.versions;
    const n = pending.planVersion ?? (plan.versions[plan.versions.length - 1]?.n ?? 0) + 1;
    const waiting: PlanVersion = {
      n,
      hash: "",
      content: pending.planContent,
      createdAt: Date.now(),
      requestId: pending.requestId,
      planFilePath: pending.planFilePath,
    };
    return [...plan.versions.filter((v) => v.n < n), waiting];
  }, [plan.versions, pending]);

  const reviewable = useMemo(() => {
    if (!pending?.planContent) return null;
    return versions.find((v) => v.requestId === pending.requestId)?.n ?? pending.planVersion ?? versions[versions.length - 1]?.n ?? null;
  }, [versions, pending]);

  const saveDraft = useCallback(
    (draft: Omit<PlanDraft, "hash"> | null) => {
      fetch(`/api/sessions/${sessionId}/plan-review/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft }),
        // A note typed just before a reload still has to arrive.
        keepalive: true,
      }).catch(() => {});
    },
    [sessionId],
  );

  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const bypassActive = bridge?.bypassActive ?? false;

  const actions = useMemo<PlanReviewActions | undefined>(() => {
    if (!pending) return undefined;
    const requestId = pending.requestId;
    const deps: PlanAnswerDeps = {
      respond: (allowed, extras) => bridgeRef.current?.respond(requestId, allowed, extras),
      sendMessage: (text) => bridgeRef.current?.sendMessage(text),
      setBypass: (enabled) => bridgeRef.current?.setBypass(enabled),
      setPlanMode: (enabled) => bridgeRef.current?.setPlanMode(enabled),
    };
    const options = planApprovalOptions(bypassActive);
    return {
      approveOptions: options,
      sendLabel: "Send to Claude",
      approve: (optionId, input) => {
        const option = options.find((o) => o.id === optionId) ?? options[0];
        approvePlan(
          option,
          {
            planFilePath: pending.planFilePath,
            planContent: input.version.content,
            editedText: input.editedText,
            annotations: input.annotations,
          },
          deps,
        );
      },
      requestChanges: (input) => {
        const diff = input.editedText !== undefined ? planEditDiff(input.version.content, input.editedText) : "";
        requestPlanChanges(input.annotations, deps, diff ? { diff } : undefined);
      },
      dismiss: () => dismissPlan(deps),
    };
  }, [pending, bypassActive]);

  if (!loaded && versions.length === 0) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading the plan…</div>;
  }

  return (
    <PlanReviewSurface
      versions={versions}
      draft={plan.draft}
      reviewable={reviewable}
      actions={actions}
      onDraftChange={saveDraft}
      empty={
        <div className="max-w-sm space-y-2">
          <p className="font-medium text-foreground">No plan yet</p>
          <p>When Claude proposes a plan in plan mode, it opens here. Select text to comment on it, send it back, or approve it.</p>
        </div>
      }
    />
  );
}
