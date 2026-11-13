// Where plans and their reviews are kept: one JSON file per plan under
// ~/.cockpit/plan-reviews. A plan belongs to a live session (what it proposed
// through ExitPlanMode) or to an issue (the plan attached to it), and either
// way it is a list of numbered versions plus the markup in progress.
//
// Reads and writes are synchronous and uncached, like issue-storage: every
// call reads the file, changes it and writes it back before returning, so two
// writers in one process cannot interleave.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  PLAN_MAX_TEXT_CHARS,
  type PlanDraft,
  type PlanRecord,
  type PlanReview,
  type PlanVersion,
  sanitizeAnnotations,
} from "@/lib/plan-review/types";
import type { IssueActor } from "@/types";
import { writeJsonAtomic } from "./atomic-write";
import { getCockpitDir } from "./paths";

export type PlanSubject = { kind: "session"; id: string } | { kind: "issue"; key: string };

/** Versions kept per plan. The oldest go first; numbers are never reused. */
export const PLAN_MAX_VERSIONS = 50;

const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;

function plansRoot(): string {
  return join(getCockpitDir(), "plan-reviews");
}

/** The file for a plan, or undefined when its id could not be a file name. */
function fileFor(subject: PlanSubject): string | undefined {
  const id = subject.kind === "session" ? subject.id : subject.key.toUpperCase();
  if (!SAFE_ID.test(id)) return undefined;
  return join(plansRoot(), `${subject.kind}-${id}.json`);
}

export function planHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function emptyRecord(): PlanRecord {
  return { versions: [] };
}

export function readPlanRecord(subject: PlanSubject): PlanRecord {
  const file = fileFor(subject);
  if (!file || !existsSync(file)) return emptyRecord();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<PlanRecord>;
    return { versions: Array.isArray(parsed.versions) ? parsed.versions : [], ...(parsed.draft ? { draft: parsed.draft } : {}) };
  } catch {
    // A file that will not parse is treated as no plan: the next write
    // replaces it, and nothing else depends on its contents.
    return emptyRecord();
  }
}

function write(subject: PlanSubject, record: PlanRecord): void {
  const file = fileFor(subject);
  if (!file) throw new Error("invalid plan subject");
  writeJsonAtomic(file, record);
}

export function latestVersion(record: PlanRecord): PlanVersion | undefined {
  return record.versions[record.versions.length - 1];
}

export interface NewPlanVersion {
  content: string;
  author?: IssueActor;
  planFilePath?: string;
  requestId?: string;
  now?: number;
}

/**
 * Keep a plan as the newest version. Text identical to the newest version is
 * the same version proposed again, not a new one: it keeps its number and its
 * history, and only what ties it to the current request moves on. Returns
 * `created: false` then.
 */
export function recordPlanVersion(subject: PlanSubject, input: NewPlanVersion): { version: PlanVersion; created: boolean } {
  const content = input.content.slice(0, PLAN_MAX_TEXT_CHARS);
  const hash = planHash(content);
  const record = readPlanRecord(subject);
  const newest = latestVersion(record);

  if (newest && newest.hash === hash) {
    const moved = newest.requestId !== input.requestId || newest.planFilePath !== input.planFilePath;
    if (moved && (input.requestId !== undefined || input.planFilePath !== undefined)) {
      if (input.requestId !== undefined) newest.requestId = input.requestId;
      if (input.planFilePath !== undefined) newest.planFilePath = input.planFilePath;
      write(subject, record);
    }
    return { version: newest, created: false };
  }

  const version: PlanVersion = {
    n: (newest?.n ?? 0) + 1,
    hash,
    content,
    createdAt: input.now ?? Date.now(),
    ...(input.author ? { author: input.author } : {}),
    ...(input.planFilePath ? { planFilePath: input.planFilePath } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
  };
  record.versions.push(version);
  if (record.versions.length > PLAN_MAX_VERSIONS) record.versions = record.versions.slice(-PLAN_MAX_VERSIONS);
  // Markup made against the old text stays in the draft: the reviewer may be
  // mid-thought, and the surface re-anchors it onto the new version.
  write(subject, record);
  return { version, created: true };
}

/** Which version a review is about: by its number, or by the request that raised it. */
export type VersionRef = { n: number } | { requestId: string };

function find(record: PlanRecord, ref: VersionRef): PlanVersion | undefined {
  return "n" in ref ? record.versions.find((v) => v.n === ref.n) : record.versions.find((v) => v.requestId === ref.requestId);
}

/**
 * Put a finished review on its version and clear the draft that produced it.
 * Returns the version, or undefined when there is no such version.
 */
export function recordPlanReview(subject: PlanSubject, ref: VersionRef, review: PlanReview): PlanVersion | undefined {
  const record = readPlanRecord(subject);
  const version = find(record, ref);
  if (!version) return undefined;
  version.review = {
    ...review,
    annotations: sanitizeAnnotations(review.annotations),
    feedback: review.feedback.slice(0, PLAN_MAX_TEXT_CHARS),
  };
  if (record.draft && record.draft.version === version.n) delete record.draft;
  write(subject, record);
  return version;
}

/**
 * Save markup in progress. A draft older than the one stored is refused, so a
 * slow save from one device cannot undo a newer one from another.
 */
export function savePlanDraft(subject: PlanSubject, draft: Omit<PlanDraft, "hash"> | null): PlanDraft | undefined {
  const record = readPlanRecord(subject);
  if (draft === null) {
    if (!record.draft) return undefined;
    delete record.draft;
    write(subject, record);
    return undefined;
  }
  const version = record.versions.find((v) => v.n === draft.version);
  if (!version) return record.draft;
  if (record.draft && record.draft.updatedAt > draft.updatedAt) return record.draft;
  const annotations = sanitizeAnnotations(draft.annotations);
  const editedText =
    typeof draft.editedText === "string" && draft.editedText !== version.content
      ? draft.editedText.slice(0, PLAN_MAX_TEXT_CHARS)
      : undefined;
  if (annotations.length === 0 && editedText === undefined) {
    // Nothing left in it: an emptied draft is no draft.
    if (record.draft) {
      delete record.draft;
      write(subject, record);
    }
    return undefined;
  }
  record.draft = {
    version: version.n,
    hash: version.hash,
    annotations,
    ...(editedText !== undefined ? { editedText } : {}),
    updatedAt: draft.updatedAt,
  };
  write(subject, record);
  return record.draft;
}

export function deletePlanRecord(subject: PlanSubject): void {
  const file = fileFor(subject);
  if (file) rmSync(file, { force: true });
}
