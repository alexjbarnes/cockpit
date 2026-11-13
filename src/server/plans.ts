import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { type PlanAnnotation, type PlanReviewOutcome, sanitizeAnnotations } from "@/lib/plan-review/types";
import { getClaudeDir } from "@/server/paths";
import { recordPlanReview, recordPlanVersion } from "./plan-review-storage";

function plansDir(): string {
  return join(getClaudeDir(), "plans");
}

export function findLatestPlanFile(): string | undefined {
  try {
    const dir = plansDir();
    const files = readdirSync(dir).filter((f) => f.endsWith(".md") && !f.includes("-agent-"));
    if (files.length === 0) return undefined;
    let latest = files[0];
    let latestMtime = 0;
    for (const f of files) {
      const mtime = statSync(join(dir, f)).mtimeMs;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latest = f;
      }
    }
    return join(dir, latest);
  } catch {
    return undefined;
  }
}

export function readPlanFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

/** Longest deny message or approved plan cockpit will pass on to the CLI. */
export const PLAN_ANSWER_MAX_CHARS = 200_000;

function clampedText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.length > PLAN_ANSWER_MAX_CHARS ? value.slice(0, PLAN_ANSWER_MAX_CHARS) : value;
}

/**
 * The parts of a permission answer the client may add to a plain yes or no:
 * the reason for a no, which the model reads as the answer to its call, and
 * for ExitPlanMode alone the plan as the user approved it. A plan text on any
 * other tool is ignored, since `plan` would be a made-up input there.
 */
export function permissionAnswerExtras(
  toolName: string | undefined,
  rawToolInput: Record<string, unknown> | undefined,
  answer: { allowed: boolean; denyMessage?: unknown; planText?: unknown },
): { toolInput: Record<string, unknown> | undefined; denyReason: string | undefined } {
  if (!answer.allowed) return { toolInput: rawToolInput, denyReason: clampedText(answer.denyMessage) };
  const planText = toolName === "ExitPlanMode" ? clampedText(answer.planText) : undefined;
  return { toolInput: planText === undefined ? rawToolInput : { ...(rawToolInput ?? {}), plan: planText }, denyReason: undefined };
}

/** Whether a path is a file inside the CLI's plans folder. Cockpit writes a
 *  plan only there: the path comes from a tool input, which is not a thing to
 *  hand to writeFile unchecked. */
export function isPlanFilePath(path: string | undefined): path is string {
  if (!path?.endsWith(".md")) return false;
  const root = resolve(plansDir());
  return resolve(path).startsWith(root + sep);
}

/** Replace a plan file's text. False when the path is not a plan file or the write fails. */
export function writePlanFile(path: string | undefined, text: string): boolean {
  if (!isPlanFilePath(path)) return false;
  try {
    writeFileSync(path, text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The plan an ExitPlanMode request is about. The CLI puts the text and the
 * file's path in the tool input, so that is the session's own plan. The
 * newest file in the plans folder is only a fallback for a CLI that sends
 * neither: it is a guess, and with two sessions planning at once it can be
 * the other one's.
 */
export function planFromRequest(rawToolInput: Record<string, unknown> | undefined): { planFilePath?: string; planContent?: string } {
  const sentPath = typeof rawToolInput?.planFilePath === "string" && rawToolInput.planFilePath ? rawToolInput.planFilePath : undefined;
  const sentPlan = typeof rawToolInput?.plan === "string" && rawToolInput.plan.trim() ? rawToolInput.plan : undefined;
  if (sentPlan !== undefined) return { planFilePath: sentPath, planContent: sentPlan };
  const path = sentPath ?? findLatestPlanFile();
  return path ? { planFilePath: path, planContent: readPlanFile(path) } : {};
}

/** A session's plan, kept as a version the moment it is proposed. Returns the
 *  version number, or undefined when there is no text or it could not be kept
 *  (a plan that cannot be stored must still be answerable). */
export function rememberSessionPlan(
  sessionId: string,
  requestId: string,
  plan: { planFilePath?: string; planContent?: string },
): number | undefined {
  if (!plan.planContent) return undefined;
  try {
    return recordPlanVersion(
      { kind: "session", id: sessionId },
      { content: plan.planContent, planFilePath: plan.planFilePath, requestId, author: { kind: "session", sessionId, sessionName: "" } },
    ).version.n;
  } catch {
    return undefined;
  }
}

const OUTCOMES: readonly PlanReviewOutcome[] = ["approved", "changes_requested", "dismissed"];

export interface PlanAnswer {
  allowed: boolean;
  denyMessage?: unknown;
  planText?: unknown;
  plan?: { outcome?: unknown; annotations?: unknown };
}

/**
 * Keep the answer to a session's plan on the version it was about.
 *
 * An approval that clears the context is sent as a no (so the old context
 * stops) while meaning yes, which is why the outcome can be stated and is not
 * read off `allowed` alone. In that case the CLI never sees the approved
 * text, so an edited plan is written to its file here; an ordinary yes
 * carries the text to the CLI, which writes the file itself.
 */
export function recordSessionPlanAnswer(
  sessionId: string,
  pending: { requestId: string; planFilePath?: string; planContent?: string },
  answer: PlanAnswer,
  now: number = Date.now(),
): void {
  const stated = OUTCOMES.find((o) => o === answer.plan?.outcome);
  const denyMessage = clampedText(answer.denyMessage);
  const outcome: PlanReviewOutcome = stated ?? (answer.allowed ? "approved" : denyMessage ? "changes_requested" : "dismissed");
  const planText = outcome === "approved" ? clampedText(answer.planText) : undefined;
  const annotations: PlanAnnotation[] = sanitizeAnnotations(answer.plan?.annotations);
  const subject = { kind: "session" as const, id: sessionId };
  try {
    recordPlanReview(
      subject,
      { requestId: pending.requestId },
      {
        outcome,
        annotations,
        feedback: outcome === "changes_requested" ? (denyMessage ?? "") : "",
        reviewer: { kind: "user" },
        reviewedAt: now,
      },
    );
    if (planText !== undefined && planText !== pending.planContent) {
      if (!answer.allowed) writePlanFile(pending.planFilePath, planText);
      // What was approved is the plan from here on, so it is a version too.
      const { version } = recordPlanVersion(subject, {
        content: planText,
        planFilePath: pending.planFilePath,
        author: { kind: "user" },
        now,
      });
      recordPlanReview(
        subject,
        { n: version.n },
        { outcome: "approved", annotations: [], feedback: "", reviewer: { kind: "user" }, reviewedAt: now },
      );
    }
  } catch {
    // The answer has already gone to the CLI; losing its record must not undo that.
  }
}
