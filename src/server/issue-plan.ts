// An issue's plan: how the work will be done, kept apart from the issue's
// description, which stays the requirement as a person wrote it. The plan is
// a list of numbered versions (plan-review-storage), written by an agent or a
// person and reviewed by a person, who approves it or sends it back with
// markup. Each of those is recorded on the issue's activity, and a review
// moves the issue on.

import { randomUUID } from "node:crypto";
import { approvedPlanText } from "@/lib/plan-review/approval";
import { planEditDiff } from "@/lib/plan-review/diff";
import { formatAnnotations, formatPlanFeedback } from "@/lib/plan-review/feedback";
import {
  PLAN_MAX_TEXT_CHARS,
  type PlanAnnotation,
  type PlanDraft,
  type PlanReview,
  type PlanVersion,
  sanitizeAnnotations,
} from "@/lib/plan-review/types";
import type { Issue, IssueActivity, IssueActor } from "@/types";
import { embedImages } from "./issue-images";
import { addIssueComment, allowedStatusesFor, applyIssueUpdate, getIssue, getProject, saveIssue } from "./issue-storage";
import { latestVersion, readPlanRecord, recordPlanReview, recordPlanVersion, savePlanDraft } from "./plan-review-storage";
import { workflowForProject } from "./workflow-storage";

/** A request the caller got wrong, with the HTTP status that says how. */
export class IssuePlanError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export interface IssuePlan {
  versions: PlanVersion[];
  draft: PlanDraft | null;
  /** The version waiting for a decision, or null when the newest has one (or
   *  there is no plan). */
  reviewable: number | null;
  /** Where each decision sends the issue. */
  targets: PlanGateTargets;
}

export interface PlanGateTargets {
  /** The status an approved plan moves the issue to. */
  approve: string;
  /** The status a plan sent back moves the issue to. */
  sendBack: string;
}

const BUILT_IN_TARGETS: PlanGateTargets = { approve: "Implementation Ready", sendBack: "Refine Ready" };

/**
 * Where a review of this issue's plan sends it. A project with a workflow
 * answers from the status where the plan is reviewed: its choices marked as
 * the approval and the send-back. Without one it is the built-in lifecycle's
 * answer: an approved plan is ready to implement, and one sent back is ready
 * to be planned again.
 */
export function planGateTargets(issue: Issue): PlanGateTargets {
  const workflow = workflowForProject(getProject(issue.projectId));
  const gate = Object.values(workflow?.statuses ?? {}).find((r) => r.kind === "human" && r.review === "plan");
  if (gate?.kind !== "human") return BUILT_IN_TARGETS;
  const approve = gate.next.find((c) => c.role === "approve");
  const sendBack = gate.next.find((c) => c.role === "sendBack");
  return { approve: approve?.status ?? BUILT_IN_TARGETS.approve, sendBack: sendBack?.status ?? BUILT_IN_TARGETS.sendBack };
}

function requireIssue(key: string): Issue {
  const issue = getIssue(key);
  if (!issue) throw new IssuePlanError(`Issue not found: ${key}`, 404);
  return issue;
}

function subjectOf(issue: Issue) {
  return { kind: "issue" as const, key: issue.key };
}

function planEntry(actor: IssueActor, now: number, extra: Pick<IssueActivity, "kind" | "planVersion" | "planOutcome">): IssueActivity {
  return { id: randomUUID(), createdAt: now, actor, ...extra };
}

export function readIssuePlan(key: string): IssuePlan {
  const issue = requireIssue(key);
  const record = readPlanRecord(subjectOf(issue));
  const newest = latestVersion(record);
  return {
    versions: record.versions,
    draft: record.draft ?? null,
    reviewable: newest && !newest.review ? newest.n : null,
    targets: planGateTargets(issue),
  };
}

/**
 * Write the issue's plan. Text that differs from the newest version becomes
 * the next version; the same text again changes nothing and is reported as
 * `created: false`.
 */
export function writeIssuePlan(
  key: string,
  content: unknown,
  actor: IssueActor,
  now: number = Date.now(),
  options: { embedImages?: boolean } = {},
): { version: PlanVersion; created: boolean } {
  if (typeof content !== "string" || content.trim() === "") throw new IssuePlanError("content must be the plan as non-empty markdown", 400);
  if (content.length > PLAN_MAX_TEXT_CHARS) throw new IssuePlanError(`The plan is longer than ${PLAN_MAX_TEXT_CHARS} characters`, 400);
  const found = requireIssue(key);
  // An agent's plan may name pictures by the files they are in. A person's
  // edit of a plan already carries the stored addresses.
  const { issue, markdown } = options.embedImages ? embedImages(found, content, now) : { issue: found, markdown: content };
  const result = recordPlanVersion(subjectOf(issue), { content: markdown, author: actor, now });
  if (result.created) {
    saveIssue({
      ...issue,
      updatedAt: now,
      activity: [...issue.activity, planEntry(actor, now, { kind: "plan_written", planVersion: result.version.n })],
    });
  } else if (issue !== found) {
    saveIssue(issue);
  }
  return result;
}

export function saveIssuePlanDraft(key: string, draft: Omit<PlanDraft, "hash"> | null): PlanDraft | null {
  const issue = requireIssue(key);
  return savePlanDraft(subjectOf(issue), draft) ?? null;
}

export type IssuePlanAction = "approve" | "request_changes";

export interface IssuePlanReviewInput {
  version: unknown;
  action: unknown;
  annotations?: unknown;
  editedText?: unknown;
}

/** Move the issue when its project has the status; a project that hides it is
 *  left where it is, since the review itself is already on record. */
function moved(issue: Issue, status: string, actor: IssueActor): Issue {
  const project = getProject(issue.projectId);
  if (project?.disabledStatuses?.includes(status)) return issue;
  return applyIssueUpdate(issue, { status }, actor, allowedStatusesFor(project));
}

/**
 * A person's decision on the newest version of an issue's plan.
 *
 * Sent back: the review is kept on that version, the feedback is posted as a
 * comment so it reads in the thread, and the issue returns to be planned
 * again. Approved: the review is kept, a plan the reviewer edited or added
 * notes to becomes the next version in their name, and the issue moves on to
 * be implemented.
 *
 * A decision on a version that is no longer the newest is refused: the plan
 * the reviewer read is not the plan any more.
 */
export function reviewIssuePlan(
  key: string,
  input: IssuePlanReviewInput,
  actor: IssueActor,
  now: number = Date.now(),
): { issue: Issue; plan: IssuePlan } {
  const action = input.action;
  if (action !== "approve" && action !== "request_changes") throw new IssuePlanError('action must be "approve" or "request_changes"', 400);
  if (typeof input.version !== "number" || !Number.isInteger(input.version))
    throw new IssuePlanError("version must be a version number", 400);

  let issue = requireIssue(key);
  const subject = subjectOf(issue);
  const newest = latestVersion(readPlanRecord(subject));
  if (!newest) throw new IssuePlanError(`${issue.key} has no plan to review`, 404);
  if (newest.n !== input.version) {
    throw new IssuePlanError(
      `Version ${input.version} is no longer the newest plan: version ${newest.n} replaced it. Review that one.`,
      409,
    );
  }
  if (newest.review) throw new IssuePlanError(`Version ${newest.n} has already been reviewed`, 409);

  const annotations: PlanAnnotation[] = sanitizeAnnotations(input.annotations);
  const editedText =
    typeof input.editedText === "string" && input.editedText.trim() !== "" && input.editedText !== newest.content
      ? input.editedText.slice(0, PLAN_MAX_TEXT_CHARS)
      : undefined;
  const targets = planGateTargets(issue);
  const reviewer = actor;

  if (action === "request_changes") {
    const diff = editedText !== undefined ? planEditDiff(newest.content, editedText) : "";
    if (annotations.length === 0 && !diff)
      throw new IssuePlanError("Say what should change: add a note, mark up the plan, or edit it", 400);
    const feedback = formatPlanFeedback(annotations, diff ? { diff } : undefined);
    const review: PlanReview = { outcome: "changes_requested", annotations, feedback, reviewer, reviewedAt: now };
    recordPlanReview(subject, { n: newest.n }, review);
    issue = addIssueComment(issue, `**Plan version ${newest.n}: changes requested**\n\n${feedback}`, actor);
    issue = {
      ...issue,
      activity: [
        ...issue.activity,
        planEntry(actor, now, { kind: "plan_reviewed", planVersion: newest.n, planOutcome: "changes_requested" }),
      ],
    };
    issue = moved(issue, targets.sendBack, actor);
    saveIssue(issue);
    return { issue, plan: readIssuePlan(issue.key) };
  }

  recordPlanReview(subject, { n: newest.n }, { outcome: "approved", annotations, feedback: "", reviewer, reviewedAt: now });
  let approved = newest.n;
  // What was approved is the plan from here on. When that is not the text as
  // proposed, it is a version of its own, in the reviewer's name.
  const text = approvedPlanText({ planContent: newest.content, editedText, annotations });
  if (text !== undefined) {
    const { version } = recordPlanVersion(subject, { content: text, author: actor, now });
    recordPlanReview(subject, { n: version.n }, { outcome: "approved", annotations: [], feedback: "", reviewer, reviewedAt: now });
    approved = version.n;
  }
  const notes = formatAnnotations(annotations);
  if (notes) issue = addIssueComment(issue, `**Plan version ${newest.n}: approved with notes**\n\n${notes}`, actor);
  const entries: IssueActivity[] = [planEntry(actor, now, { kind: "plan_reviewed", planVersion: newest.n, planOutcome: "approved" })];
  if (approved !== newest.n) entries.unshift(planEntry(actor, now, { kind: "plan_written", planVersion: approved }));
  issue = { ...issue, updatedAt: now, activity: [...issue.activity, ...entries] };
  issue = moved(issue, targets.approve, actor);
  saveIssue(issue);
  return { issue, plan: readIssuePlan(issue.key) };
}
