// Plan review's data, shared by the browser and the server. A plan is a
// markdown document proposed by an agent: a live session's ExitPlanMode plan,
// or the plan attached to an issue. Either way it is kept as numbered
// versions, and a person's markup is kept on the version it was made against.

import type { IssueActor } from "@/types";

/** What a piece of markup asks for. A note is about the plan as a whole and
 *  has no selected text. */
export type PlanAnnotationKind = "comment" | "remove" | "replace" | "note";

export const PLAN_ANNOTATION_KINDS: readonly PlanAnnotationKind[] = ["comment", "remove", "replace", "note"];

export interface PlanAnnotation {
  id: string;
  kind: PlanAnnotationKind;
  /** The selected text, as it reads on screen. Empty for a note. */
  quote: string;
  /** A little of the text either side of the selection, which is what finds
   *  it again after a reload, on another device, or in a revised plan. */
  prefix: string;
  suffix: string;
  /** 1-based lines of the markdown source the selection falls in, when known. */
  lineStart?: number;
  lineEnd?: number;
  /** The comment, the replacement text, or the note. Empty for a plain removal. */
  body: string;
  /** Id of a quick label, when the markup was made with one. */
  label?: string;
  createdAt: number;
}

export type PlanReviewOutcome = "approved" | "changes_requested" | "dismissed";

/** One round of review, kept on the version it was about. */
export interface PlanReview {
  outcome: PlanReviewOutcome;
  annotations: PlanAnnotation[];
  /** What was sent to the agent, exactly as sent. Empty when nothing was. */
  feedback: string;
  reviewer?: IssueActor;
  reviewedAt: number;
}

export interface PlanVersion {
  /** 1-based and never reused, so "v3" always means the same text. */
  n: number;
  hash: string;
  content: string;
  createdAt: number;
  author?: IssueActor;
  /** Session plans only: the CLI's plan file, and the request waiting on it. */
  planFilePath?: string;
  requestId?: string;
  review?: PlanReview;
}

/** Markup in progress. One per plan, against one version. */
export interface PlanDraft {
  version: number;
  hash: string;
  annotations: PlanAnnotation[];
  /** The plan as the reviewer has edited it, when they have. */
  editedText?: string;
  updatedAt: number;
}

export interface PlanRecord {
  versions: PlanVersion[];
  draft?: PlanDraft;
}

export const PLAN_MAX_ANNOTATIONS = 500;
export const PLAN_MAX_TEXT_CHARS = 200_000;
const MAX_QUOTE_CHARS = 20_000;
const MAX_CONTEXT_CHARS = 200;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function line(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Markup as it arrives from a browser, reduced to what the type allows.
 * Anything that is not an annotation is dropped, never repaired: a draft is
 * the user's own work and a guess at what a broken entry meant would put
 * words in their mouth.
 */
export function sanitizeAnnotations(value: unknown): PlanAnnotation[] {
  if (!Array.isArray(value)) return [];
  const out: PlanAnnotation[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (out.length >= PLAN_MAX_ANNOTATIONS) break;
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const kind = a.kind as PlanAnnotationKind;
    if (typeof a.id !== "string" || a.id === "" || a.id.length > 100 || seen.has(a.id)) continue;
    if (!PLAN_ANNOTATION_KINDS.includes(kind)) continue;
    const quote = text(a.quote, MAX_QUOTE_CHARS);
    const body = text(a.body, MAX_QUOTE_CHARS);
    // Markup on nothing, or a note or comment that says nothing, is not markup.
    if (kind !== "note" && quote.trim() === "") continue;
    if ((kind === "note" || kind === "comment") && body.trim() === "" && typeof a.label !== "string") continue;
    seen.add(a.id);
    const lineStart = line(a.lineStart);
    const lineEnd = line(a.lineEnd);
    out.push({
      id: a.id,
      kind,
      quote: kind === "note" ? "" : quote,
      prefix: text(a.prefix, MAX_CONTEXT_CHARS),
      suffix: text(a.suffix, MAX_CONTEXT_CHARS),
      ...(lineStart !== undefined ? { lineStart } : {}),
      ...(lineEnd !== undefined ? { lineEnd } : {}),
      body,
      ...(typeof a.label === "string" && a.label !== "" ? { label: a.label.slice(0, 60) } : {}),
      createdAt: typeof a.createdAt === "number" && Number.isFinite(a.createdAt) ? a.createdAt : Date.now(),
    });
  }
  return out;
}
