"use client";

import { ClipboardCheck, ClipboardList, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PendingPermission } from "@/hooks/use-session";
import {
  approvePlan,
  dismissPlan,
  type PlanAnswerDeps,
  type PlanAnswerExtras,
  planApprovalOptions,
  requestPlanChanges,
} from "@/lib/plan-review/approval";
import { noteFromText } from "@/lib/plan-review/feedback";
import type { PermissionMode } from "@/types";
import { PlanViewModal } from "./plan-view-modal";

interface AllowedPrompt {
  tool: string;
  prompt: string;
}

interface PlanApprovalPromptProps {
  permission: PendingPermission;
  bypassActive: boolean;
  onRespond: (
    requestId: string,
    allowed: boolean,
    permissionMode?: PermissionMode,
    suggestionIndex?: number,
    extras?: PlanAnswerExtras,
  ) => void;
  onSendMessage: (text: string) => void;
  onSetBypass: (enabled: boolean) => void;
  onSetPlanMode: (enabled: boolean) => void;
  /** Open the plan for review in its tab. Absent where there are no tabs (the
   *  assistant's modal), and the plan then opens in a read-only modal. */
  onReview?: () => void;
}

export function PlanApprovalPrompt({
  permission,
  bypassActive,
  onRespond,
  onSendMessage,
  onSetBypass,
  onSetPlanMode,
  onReview,
}: PlanApprovalPromptProps) {
  const options = planApprovalOptions(bypassActive);
  const [selected, setSelected] = useState(0);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);

  const allowedPrompts = useMemo<AllowedPrompt[]>(() => {
    if (!permission.input) return [];
    try {
      const parsed = JSON.parse(permission.input);
      return (parsed.allowedPrompts as AllowedPrompt[]) || [];
    } catch {
      return [];
    }
  }, [permission.input]);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (showFeedback) {
      feedbackRef.current?.focus();
    }
  }, [showFeedback]);

  const deps = useMemo<PlanAnswerDeps>(
    () => ({
      respond: (allowed, extras) => onRespond(permission.requestId, allowed, allowed ? "allow" : "deny", undefined, extras),
      sendMessage: onSendMessage,
      setBypass: onSetBypass,
      setPlanMode: onSetPlanMode,
    }),
    [permission.requestId, onRespond, onSendMessage, onSetBypass, onSetPlanMode],
  );

  const handleProceed = useCallback(
    (optionIndex: number) => {
      approvePlan(options[optionIndex], { planFilePath: permission.planFilePath, planContent: permission.planContent }, deps);
    },
    [options, permission.planFilePath, permission.planContent, deps],
  );

  const handleDismiss = useCallback(() => dismissPlan(deps), [deps]);

  // The text goes back as the answer to the plan itself, so the model reads
  // it where it expects a verdict and revises in the same turn.
  const handleSendFeedback = useCallback(() => {
    const text = feedback.trim();
    if (!text) return;
    requestPlanChanges([noteFromText(text)], deps);
  }, [feedback, deps]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showFeedback) {
        if (e.key === "Escape") {
          e.preventDefault();
          setShowFeedback(false);
          containerRef.current?.focus();
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSendFeedback();
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        handleDismiss();
        return;
      }
      if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setSelected((s) => Math.max(0, s - 1));
      } else if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setSelected((s) => Math.min(options.length + 1, s + 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (selected === options.length) {
          setShowFeedback(true);
        } else if (selected === options.length + 1) {
          handleDismiss();
        } else {
          handleProceed(selected);
        }
      }
    },
    [options, showFeedback, selected, handleProceed, handleSendFeedback, handleDismiss],
  );

  return (
    <>
      <div className="mx-auto max-w-3xl" data-testid="plan-approval-prompt">
        <div
          ref={containerRef}
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          className="rounded-lg border border-blue-500/50 bg-blue-500/10 p-4 outline-none"
        >
          <div className="flex items-start gap-3">
            <ClipboardCheck className="h-5 w-5 shrink-0 text-blue-500 mt-0.5" />
            <div className="flex-1 min-w-0 space-y-3">
              <div className="flex items-center gap-2">
                <div className="text-sm font-medium">Would you like to proceed?</div>
                {permission.planContent && (
                  <button
                    onClick={() => (onReview ? onReview() : setPlanModalOpen(true))}
                    data-testid="btn-review-plan"
                    className="flex items-center gap-1 rounded border border-blue-500/50 px-2 py-1 text-xs font-medium text-blue-500 hover:bg-blue-500/10"
                  >
                    <ClipboardList className="h-3 w-3" />
                    {onReview ? "Review plan" : "View plan"}
                  </button>
                )}
              </div>
              {allowedPrompts.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Permissions requested for implementation:</div>
                  <ul className="text-xs text-muted-foreground space-y-0.5">
                    {allowedPrompts.map((p, i) => (
                      <li key={i} className="flex items-center gap-1.5 pl-2">
                        <span className="font-mono text-foreground/70">{p.tool}</span>
                        <span>{p.prompt}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="space-y-0.5">
                {options.map((opt, i) => (
                  <button
                    key={i}
                    onClick={() => handleProceed(i)}
                    onMouseEnter={() => setSelected(i)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                      selected === i ? "bg-blue-600/20 text-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <span className="shrink-0 font-mono text-blue-500 w-4">{i + 1}.</span>
                    <span>{opt.label}</span>
                    {i === 0 && <span className="ml-auto text-[10px] text-muted-foreground hidden sm:inline">default</span>}
                  </button>
                ))}
                <button
                  onClick={() => setShowFeedback(true)}
                  onMouseEnter={() => setSelected(options.length)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                    selected === options.length ? "bg-blue-600/20 text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className="shrink-0 font-mono text-blue-500 w-4">{options.length + 1}.</span>
                  <span>Tell Claude what to change</span>
                </button>
                <button
                  onClick={handleDismiss}
                  onMouseEnter={() => setSelected(options.length + 1)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                    selected === options.length + 1 ? "bg-blue-600/20 text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className="shrink-0 font-mono text-muted-foreground w-4">Esc</span>
                  <span>Dismiss</span>
                </button>
              </div>
              {showFeedback && (
                <div className="space-y-2">
                  <textarea
                    ref={feedbackRef}
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="Describe what you'd like to change about the plan..."
                    className="w-full rounded border border-border bg-background px-3 py-2 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
                    rows={3}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleSendFeedback}
                      disabled={!feedback.trim()}
                      className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Send className="h-3 w-3" />
                      Send feedback
                    </button>
                    <button
                      onClick={() => {
                        setShowFeedback(false);
                        containerRef.current?.focus();
                      }}
                      className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {permission.planContent && !onReview && (
        <PlanViewModal
          open={planModalOpen}
          onOpenChange={setPlanModalOpen}
          content={permission.planContent}
          filePath={permission.planFilePath ?? "Plan"}
        />
      )}
    </>
  );
}
