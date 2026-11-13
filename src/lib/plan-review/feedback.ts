// What a reviewer's markup becomes when it is sent to the agent. One function
// writes it, for a live session and for an issue alike, so a note reads the
// same wherever it was made and the tests have one place to look.

import { planLabel } from "./labels";
import type { PlanAnnotation } from "./types";

const QUOTE_INLINE_MAX = 160;

/** Document order: by line, then as written. Notes about the whole plan go last. */
export function sortAnnotations(annotations: readonly PlanAnnotation[]): PlanAnnotation[] {
  const anchored = annotations.filter((a) => a.kind !== "note");
  const notes = annotations.filter((a) => a.kind === "note");
  const byLine = (a: PlanAnnotation, b: PlanAnnotation) =>
    (a.lineStart ?? Number.MAX_SAFE_INTEGER) - (b.lineStart ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt;
  const byTime = (a: PlanAnnotation, b: PlanAnnotation) => a.createdAt - b.createdAt;
  return [...anchored.sort(byLine), ...notes.sort(byTime)];
}

function where(a: PlanAnnotation): string {
  if (a.lineStart === undefined) return "";
  const end = a.lineEnd ?? a.lineStart;
  return end > a.lineStart ? ` (lines ${a.lineStart} to ${end})` : ` (line ${a.lineStart})`;
}

/** A selection quoted so it survives being markdown inside markdown. */
function quoted(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!text.includes("\n") && flat.length <= QUOTE_INLINE_MAX && !flat.includes("`")) return `\`${flat}\``;
  // A fence longer than any run of backticks in the text cannot be closed by it.
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `\n${fence}\n${text.replace(/\n+$/, "")}\n${fence}`;
}

function indent(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((l) => `> ${l}`.trimEnd())
    .join("\n");
}

function entry(a: PlanAnnotation, index: number): string {
  const head = `${index + 1}.`;
  const label = planLabel(a.label);
  const said = [label ? `${label.name}. ${label.ask}` : "", a.body.trim()].filter(Boolean).join("\n");
  switch (a.kind) {
    case "remove":
      return `${head} Remove this${where(a)}: ${quoted(a.quote)}${said ? `\n${indent(said)}` : ""}`;
    case "replace":
      return `${head} Replace this${where(a)}: ${quoted(a.quote)}\nWith:\n${indent(a.body)}`;
    case "note":
      return `${head} About the plan as a whole:\n${indent(said)}`;
    default:
      return `${head} On this${where(a)}: ${quoted(a.quote)}\n${indent(said)}`;
  }
}

/** The numbered points alone. Empty when there is no markup. */
export function formatAnnotations(annotations: readonly PlanAnnotation[]): string {
  return sortAnnotations(annotations)
    .map((a, i) => entry(a, i))
    .join("\n\n");
}

export interface PlanEdits {
  /** A unified diff of the reviewer's own changes to the plan text. */
  diff: string;
}

/**
 * The answer to a plan that is being sent back. It is the tool result the
 * agent reads, so it opens by saying what happened and what to do next, and
 * the reviewer's own words follow untouched.
 */
export function formatPlanFeedback(annotations: readonly PlanAnnotation[], edits?: PlanEdits): string {
  const points = formatAnnotations(annotations);
  const count = sortAnnotations(annotations).length;
  const parts = [
    "The user reviewed the plan and asked for changes. It is not approved.",
    "Revise the plan to address every point below, then propose it again. Do not propose it again unchanged, and keep the parts that were not commented on as they are.",
  ];
  if (count > 0) parts.push(`## Review notes (${count})\n\n${points}`);
  if (edits?.diff.trim()) {
    parts.push(
      `## The user's own edits\n\nThe user changed the plan text directly. Keep these changes in the revised plan.\n\n\`\`\`diff\n${edits.diff.trim()}\n\`\`\``,
    );
  }
  return parts.join("\n\n");
}

/** The heading the notes sit under when they travel inside an approved plan. */
export const PLAN_NOTES_HEADING = "## Notes from the user";

/**
 * A plan approved with notes: the plan, then the notes as a section of it.
 * The notes ride in the plan text because that is the one thing an approval
 * can carry, and because a fresh context told to implement the plan file
 * reads them there too.
 */
export function planWithNotes(plan: string, annotations: readonly PlanAnnotation[]): string {
  const points = formatAnnotations(annotations);
  if (!points) return plan;
  const intro = "The user approved this plan and added these notes. Take them into account as you implement it.";
  return `${plan.replace(/\s+$/, "")}\n\n${PLAN_NOTES_HEADING}\n\n${intro}\n\n${points}\n`;
}

/** A plain typed message, as a single note about the whole plan. */
export function noteFromText(body: string, now: number = Date.now()): PlanAnnotation {
  return { id: `note-${now}`, kind: "note", quote: "", prefix: "", suffix: "", body, createdAt: now };
}
