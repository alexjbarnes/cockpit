// How a plan is answered. The card in the chat and the Plan tab both answer
// through here, so the same choice does the same thing from either.

import { formatPlanFeedback, type PlanEdits, planWithNotes } from "./feedback";
import type { PlanAnnotation, PlanReviewOutcome } from "./types";

export interface PlanApprovalOption {
  id: string;
  label: string;
  /** Start the implementation in a fresh context that reads the plan file. */
  clearContext: boolean;
  /** Stop asking before each edit once the plan is approved. */
  autoAccept: boolean;
}

const ALL_OPTIONS: readonly PlanApprovalOption[] = [
  { id: "clear-auto", label: "Yes, clear context and auto-accept edits", clearContext: true, autoAccept: true },
  { id: "clear-manual", label: "Yes, clear context and manually approve edits", clearContext: true, autoAccept: false },
  { id: "keep-auto", label: "Yes, auto-accept edits", clearContext: false, autoAccept: true },
  { id: "keep-manual", label: "Yes, manually approve edits", clearContext: false, autoAccept: false },
];

const BYPASS_OPTIONS: readonly PlanApprovalOption[] = [
  { id: "clear-auto", label: "Yes, clear context and implement", clearContext: true, autoAccept: true },
  { id: "keep-auto", label: "Yes, continue implementing", clearContext: false, autoAccept: true },
];

/** The ways to say yes. With bypass already on there is nothing to choose
 *  about edits, so only the context question is left. */
export function planApprovalOptions(bypassActive: boolean): readonly PlanApprovalOption[] {
  return bypassActive ? BYPASS_OPTIONS : ALL_OPTIONS;
}

/** What goes with the yes or no. Mirrors the optional fields of the
 *  `permission:response` message. */
export interface PlanAnswerExtras {
  denyMessage?: string;
  planText?: string;
  plan?: { outcome?: PlanReviewOutcome; annotations?: PlanAnnotation[] };
}

export interface PlanAnswerDeps {
  respond: (allowed: boolean, extras?: PlanAnswerExtras) => void;
  sendMessage: (text: string) => void;
  setBypass: (enabled: boolean) => void;
  setPlanMode: (enabled: boolean) => void;
  /** setTimeout, injectable so the order of the steps can be tested. */
  schedule?: (fn: () => void, ms: number) => void;
}

export interface PlanApprovalInput {
  planFilePath?: string;
  /** The plan as proposed. */
  planContent?: string;
  /** The plan as the reviewer edited it, when they did. */
  editedText?: string;
  /** Markup to pass on as notes for the implementation. */
  annotations?: PlanAnnotation[];
}

const later = (fn: () => void, ms: number) => {
  setTimeout(fn, ms);
};

/** The text to approve when it is not simply the plan as proposed. */
export function approvedPlanText(input: PlanApprovalInput): string | undefined {
  const base = input.editedText ?? input.planContent;
  if (base === undefined) return undefined;
  const text = planWithNotes(base, input.annotations ?? []);
  return text === input.planContent ? undefined : text;
}

export function approvePlan(option: PlanApprovalOption, input: PlanApprovalInput, deps: PlanAnswerDeps): void {
  const schedule = deps.schedule ?? later;
  const planText = approvedPlanText(input);
  const plan = { outcome: "approved" as const, annotations: input.annotations ?? [] };
  if (option.autoAccept) deps.setBypass(true);
  if (!option.clearContext) {
    deps.respond(true, { ...(planText !== undefined ? { planText } : {}), plan });
    return;
  }
  // Clearing the context: the plan is refused so the old context stops, the
  // conversation is cleared, and a fresh turn is told to implement the plan
  // file. /clear starts a new CLI session that knows nothing of the plan, so
  // the message names the file. The server writes an edited plan to that file,
  // since a refusal carries no text to the CLI.
  const planRef = input.planFilePath ? ` at ${input.planFilePath}` : "";
  deps.respond(false, { ...(planText !== undefined ? { planText } : {}), plan });
  deps.setPlanMode(false);
  schedule(() => {
    deps.sendMessage("/clear");
    schedule(() => deps.sendMessage(`Implement the plan${planRef}`), 200);
  }, 100);
}

/** Send the plan back with the reviewer's markup as the answer to it. */
export function requestPlanChanges(annotations: PlanAnnotation[], deps: PlanAnswerDeps, edits?: PlanEdits): void {
  deps.respond(false, { denyMessage: formatPlanFeedback(annotations, edits), plan: { outcome: "changes_requested", annotations } });
}

/** Put the plan aside without answering it either way. */
export function dismissPlan(deps: PlanAnswerDeps): void {
  const schedule = deps.schedule ?? later;
  deps.respond(false, { plan: { outcome: "dismissed" } });
  // ExitPlanMode may already have moved the CLI out of plan mode before the
  // request was answered, so plan mode is asked for again.
  schedule(() => deps.setPlanMode(true), 100);
}
