import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { writeJsonAtomic } from "@/server/atomic-write";
import { emitIssueStatusChange } from "@/server/issue-events";
import { getCockpitDir, getIssueAttachmentsRoot } from "@/server/paths";
import type { CustomStatus, Issue, IssueActivity, IssueActor, IssueAttachment, IssueComment, Project } from "@/types";
import { ISSUE_STATUSES } from "@/types";

function cockpitDir(): string {
  return getCockpitDir();
}
function projectsFile(): string {
  return join(cockpitDir(), "projects.json");
}
function issuesDir(): string {
  return join(cockpitDir(), "issues");
}
/** Raw path builder — no validation. Only safe to call with a projectId
 *  already known to be a real project's id (see safeIssuesFile below for the
 *  guarded version any caller-supplied projectId must go through instead). */
function issuesFile(projectId: string): string {
  return join(issuesDir(), `${projectId}.json`);
}

/** True if `target` (an absolute path) is strictly inside `root` (an
 *  absolute directory path) — not equal to it, and not merely a
 *  string-prefix match on a sibling that happens to share the prefix (hence
 *  comparing against `root + sep`). Mirrors job-storage.ts's
 *  deleteJobScratchpad containment check. */
function isContainedIn(root: string, target: string): boolean {
  return target !== root && target.startsWith(root + sep);
}

/**
 * Resolve a caller-supplied projectId to its issues file path, or undefined
 * if it isn't safe to use. `issuesFile()` is a plain `join()`, so a
 * projectId like "../../escaped" resolves outside `issuesDir()` entirely —
 * confirmed live: with COCKPIT_CONFIG_DIR=/tmp/probe-XXXX,
 * saveIssue({...issue, projectId: "../../escaped"}) wrote
 * /tmp/escaped.json. No caller can reach loadIssues/saveIssue with an
 * attacker-influenced projectId yet, but phase 2.3 will pass a model-supplied
 * `project` argument straight into these from a plain session, and the spec
 * itself accepts that a poisoned README can drive issue writes — this has to
 * hold before that lands, not after.
 *
 * Two independent checks, belt and braces (same reasoning as
 * deleteJobScratchpad, which double-checks containment even though its
 * caller already validated the id): projectId must name a real, known
 * project — the stronger defense, since a crafted id can never coincidentally
 * equal a stored uuid — AND the resolved path must actually stay inside
 * issuesDir(), which still holds even if a project's `id` were ever something
 * other than a safe randomUUID() (buildProject always uses one, but
 * saveProject itself does not re-validate id shape, so this is not
 * hypothetical-only — see the "defense in depth" test).
 */
function safeIssuesFile(projectId: string): string | undefined {
  const root = resolve(issuesDir());
  const target = resolve(issuesFile(projectId));
  if (!isContainedIn(root, target)) return undefined;
  if (!getProject(projectId)) return undefined;
  return target;
}

function normalizePrefix(prefix: string): string {
  return prefix.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Value validation
// ---------------------------------------------------------------------------
//
// "One construction path" (buildIssue/applyIssueUpdate/buildProject/
// applyProjectUpdate) controls *which* fields a caller can set — the part
// that stopped create_job's schema/handler drift. It does nothing about
// *values*: nothing stopped a caller from handing buildIssue a status that
// isn't in IssueStatus, a priority outside 0-4, or labels that aren't
// strings, so each caller had to validate independently — which is exactly
// how two paths drift. They already had: the REST route passed a raw parsed
// request body straight through with no checks at all, and a payload shaped
// like `{ status: "Definitely Not A Status", priority: "critical", labels:
// "not-an-array", title: 12345 }` was stored as-is, while the MCP tool
// rejected the identical payload. Validating here, in the one place both
// callers (and any future one — an import script, phase 4's status trigger)
// funnel through, closes that gap at its root instead of adding a third
// hand-rolled copy of the same checks.
//
// The MCP tool's own validation (cockpit-config-server.ts) stays exactly as
// it is and still runs first for that caller — it produces a better message
// and returns an isError tool result instead of throwing. What's here is
// belt and braces for MCP, and the *only* line of defence for REST (and any
// future caller that reaches these functions directly).

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
}

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
}

/** The status names a project accepts: the built-in lifecycle plus its own
 *  custom statuses. A project with no custom statuses (or no project context)
 *  accepts exactly the built-ins, matching the old behaviour. */
export function allowedStatusesFor(project?: Project): string[] {
  return [...ISSUE_STATUSES, ...(project?.customStatuses ?? []).map((s) => s.name)];
}

function assertValidStatus(value: unknown, allowed: readonly string[] = ISSUE_STATUSES): asserts value is string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`status must be one of: ${allowed.join(", ")}`);
  }
}

const VALID_PRIORITIES = [0, 1, 2, 3, 4] as const;

function assertValidPriority(value: unknown): asserts value is 0 | 1 | 2 | 3 | 4 {
  if (typeof value !== "number" || !(VALID_PRIORITIES as readonly number[]).includes(value)) {
    throw new Error(`priority must be one of: ${VALID_PRIORITIES.join(", ")}`);
  }
}

function assertValidLabels(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((l) => typeof l === "string")) {
    throw new Error("labels must be an array of strings");
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function loadProjects(): Project[] {
  try {
    const data = JSON.parse(readFileSync(projectsFile(), "utf-8"));
    return data.projects || [];
  } catch {
    // Missing file (first run) and corrupt/unreadable file both land here.
    // Mirrors job-storage.ts's loadJobs(): one bad file must not take the
    // rest of the server down.
    return [];
  }
}

export function getProject(id: string): Project | undefined {
  return loadProjects().find((p) => p.id === id);
}

function getProjectByPrefix(prefix: string): Project | undefined {
  const normalized = normalizePrefix(prefix);
  return loadProjects().find((p) => normalizePrefix(p.prefix) === normalized);
}

/** Everything a caller may supply when creating a project. */
export type ProjectInput = Partial<Omit<Project, "id" | "createdAt" | "updatedAt" | "nextNumber">> & {
  name: string;
  prefix: string;
};

/**
 * Build a stored project from caller input, applying the defaults it needs.
 * Mirrors job-storage.ts's buildJob(): one construction path, so the REST
 * route and the MCP tools (phase 2.3) cannot independently assign a
 * different subset of fields the way create_job's schema and handler once
 * did (19 fields advertised, 5 assigned).
 *
 * Validates before doing anything else — including before prefix
 * normalisation, so a bad value can never reach `.trim()`/`.toUpperCase()`
 * and surface as an unrelated TypeError instead of a clear message.
 */
/** Validate the per-project status config. Built-ins named to disable must be
 *  real built-ins; custom statuses must be non-empty, unique among themselves
 *  (case-insensitive), and must not shadow a built-in name. Returns cleaned
 *  copies (trimmed names) so storage never holds stray whitespace. */
function validateStatusConfig(
  disabledStatuses: unknown,
  customStatuses: unknown,
): { disabledStatuses?: string[]; customStatuses?: CustomStatus[] } {
  const out: { disabledStatuses?: string[]; customStatuses?: CustomStatus[] } = {};
  const builtinLower = new Set((ISSUE_STATUSES as readonly string[]).map((s) => s.toLowerCase()));

  if (disabledStatuses !== undefined) {
    if (!Array.isArray(disabledStatuses) || !disabledStatuses.every((s) => typeof s === "string")) {
      throw new Error("disabledStatuses must be an array of strings");
    }
    for (const s of disabledStatuses) {
      if (!(ISSUE_STATUSES as readonly string[]).includes(s)) {
        throw new Error(`disabledStatuses may only name built-in statuses; "${s}" is not one of: ${ISSUE_STATUSES.join(", ")}`);
      }
    }
    out.disabledStatuses = [...disabledStatuses];
  }

  if (customStatuses !== undefined) {
    if (!Array.isArray(customStatuses)) throw new Error("customStatuses must be an array");
    const seen = new Set<string>();
    const cleaned: CustomStatus[] = [];
    for (const entry of customStatuses) {
      if (typeof entry !== "object" || entry === null) throw new Error("each custom status must be an object with a name");
      const name = (entry as { name?: unknown }).name;
      const color = (entry as { color?: unknown }).color;
      if (typeof name !== "string" || name.trim() === "") throw new Error("each custom status needs a non-empty name");
      const trimmed = name.trim();
      const lower = trimmed.toLowerCase();
      if (builtinLower.has(lower)) throw new Error(`custom status "${trimmed}" collides with a built-in status name`);
      if (seen.has(lower)) throw new Error(`duplicate custom status name "${trimmed}"`);
      seen.add(lower);
      if (color !== undefined && typeof color !== "string") throw new Error("custom status color must be a string");
      cleaned.push(color === undefined ? { name: trimmed } : { name: trimmed, color });
    }
    out.customStatuses = cleaned;
  }

  return out;
}

export function buildProject(input: ProjectInput): Project {
  assertNonEmptyString(input.name, "name");
  assertNonEmptyString(input.prefix, "prefix");
  if (input.description !== undefined) assertString(input.description, "description");
  if (input.repoPath !== undefined) assertString(input.repoPath, "repoPath");
  if (input.archived !== undefined) assertBoolean(input.archived, "archived");
  const statusConfig = validateStatusConfig(input.disabledStatuses, input.customStatuses);

  const now = Date.now();
  return {
    id: randomUUID(),
    name: input.name,
    prefix: normalizePrefix(input.prefix),
    description: input.description,
    repoPath: input.repoPath,
    archived: input.archived ?? false,
    createdAt: now,
    updatedAt: now,
    nextNumber: 1,
    ...statusConfig,
  };
}

export type ProjectUpdateInput = Partial<
  Pick<Project, "name" | "prefix" | "description" | "repoPath" | "archived" | "disabledStatuses" | "customStatuses">
>;

/**
 * Apply a patch to an existing project. Pure — does not persist; the caller
 * passes the result to saveProject(). Validates every touched field upfront,
 * before any diffing/mutation starts, so a bad value never produces a
 * partially-applied patch.
 */
export function applyProjectUpdate(project: Project, patch: ProjectUpdateInput): Project {
  if (patch.name !== undefined) assertNonEmptyString(patch.name, "name");
  if (patch.prefix !== undefined) assertNonEmptyString(patch.prefix, "prefix");
  if (patch.description !== undefined) assertString(patch.description, "description");
  if (patch.repoPath !== undefined) assertString(patch.repoPath, "repoPath");
  if (patch.archived !== undefined) assertBoolean(patch.archived, "archived");
  const statusConfig = validateStatusConfig(patch.disabledStatuses, patch.customStatuses);

  const next: Project = { ...project };
  let changed = false;

  if (patch.disabledStatuses !== undefined && JSON.stringify(statusConfig.disabledStatuses) !== JSON.stringify(next.disabledStatuses)) {
    next.disabledStatuses = statusConfig.disabledStatuses;
    changed = true;
  }
  if (patch.customStatuses !== undefined && JSON.stringify(statusConfig.customStatuses) !== JSON.stringify(next.customStatuses)) {
    next.customStatuses = statusConfig.customStatuses;
    changed = true;
  }

  if (patch.name !== undefined && patch.name !== next.name) {
    next.name = patch.name;
    changed = true;
  }
  if (patch.prefix !== undefined) {
    const normalized = normalizePrefix(patch.prefix);
    if (normalized !== next.prefix) {
      next.prefix = normalized;
      changed = true;
    }
  }
  if (patch.description !== undefined && patch.description !== next.description) {
    next.description = patch.description;
    changed = true;
  }
  if (patch.repoPath !== undefined && patch.repoPath !== next.repoPath) {
    next.repoPath = patch.repoPath;
    changed = true;
  }
  if (patch.archived !== undefined && patch.archived !== next.archived) {
    next.archived = patch.archived;
    changed = true;
  }

  if (!changed) return project; // no-op patch: same reference back, matching applyIssueUpdate's contract
  next.updatedAt = Date.now();
  return next;
}

/**
 * Persist a project (insert or update by id). Prefix uniqueness and
 * uppercasing are enforced here rather than in buildProject/applyProjectUpdate,
 * because this is the one place that can see every other project on disk —
 * keys are derived from prefix (see getIssue), so two projects sharing one
 * would make key -> project lookup ambiguous.
 *
 * A prefix change is also rejected once the project has at least one issue.
 * getIssue resolves a key's project purely from the prefix, so an issue
 * created under the old prefix (e.g. "CK-1") becomes permanently unreachable
 * the moment the prefix changes — confirmed live: after renaming CK to RO
 * with an existing CK-1, both getIssue("CK-1") and getIssue("RO-1") returned
 * undefined, and the counter had already moved past a key that was never
 * used. The spec calls the key "what humans and branches use" — keys end up
 * in branch names, PR titles and commit messages, so they're treated as
 * immutable once assigned rather than rewritten. An empty project (no issues
 * yet) can still have its prefix changed freely.
 */
export function saveProject(project: Project): void {
  const prefix = normalizePrefix(project.prefix);
  if (!prefix) throw new Error("Project prefix must not be empty");

  const projects = loadProjects();
  const idx = projects.findIndex((p) => p.id === project.id);

  if (idx >= 0) {
    const existingPrefix = normalizePrefix(projects[idx].prefix);
    if (existingPrefix !== prefix && loadIssues(project.id).length > 0) {
      throw new Error(
        `Cannot change project "${project.id}"'s prefix from "${existingPrefix}" to "${prefix}": it already has issues, and issue keys (used in branch names, PR titles and commits) are immutable once assigned. Only a project with no issues yet may have its prefix changed.`,
      );
    }
  }

  const collision = projects.find((p) => p.id !== project.id && normalizePrefix(p.prefix) === prefix);
  if (collision) {
    throw new Error(`Project prefix "${prefix}" is already used by project "${collision.name}" (${collision.id})`);
  }

  const toSave: Project = { ...project, prefix };
  if (idx >= 0) {
    projects[idx] = toSave;
  } else {
    projects.push(toSave);
  }
  writeJsonAtomic(projectsFile(), { projects });
}

/**
 * Remove a project and its issues file. Deleting a *project* stays a UI-only
 * operation (never an MCP tool, so a session cannot reach it) — enforced by
 * phase 2.3 exposing no tool for this, not by anything here.
 */
export function deleteProject(id: string): boolean {
  const projects = loadProjects();
  const filtered = projects.filter((p) => p.id !== id);
  if (filtered.length === projects.length) return false;
  writeJsonAtomic(projectsFile(), { projects: filtered });

  try {
    // Containment check only, not the full safeIssuesFile: the project
    // record was just removed from `projects` above, so getProject(id) would
    // now (incorrectly) return undefined even for this legitimate cleanup.
    // `id` is already known to have matched a real, just-removed project
    // (that's what the filtered-length check above confirmed) — this is
    // belt and braces, same reasoning as job-storage.ts's
    // deleteJobScratchpad.
    const root = resolve(issuesDir());
    const target = resolve(issuesFile(id));
    if (isContainedIn(root, target) && existsSync(target)) unlinkSync(target);
  } catch {
    // best effort
  }

  return true;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export function loadIssues(projectId: string): Issue[] {
  const file = safeIssuesFile(projectId);
  if (!file) return []; // unknown/unsafe projectId: same as "no issues", not an error — this is a read
  try {
    const data = JSON.parse(readFileSync(file, "utf-8"));
    return data.issues || [];
  } catch {
    // Missing file (no issues yet, a perfectly real project) and
    // corrupt/unreadable file both land here, same as loadProjects() above.
    return [];
  }
}

/** Split "CK-12" into its prefix ("CK"). Returns undefined for anything that
 *  doesn't look like a key at all, so callers can short-circuit without
 *  touching disk. */
function keyPrefix(key: string): string | undefined {
  const idx = key.lastIndexOf("-");
  if (idx <= 0) return undefined;
  return key.slice(0, idx);
}

/**
 * Find an issue by its human key ("CK-12") without the caller knowing which
 * project it belongs to: the prefix before the dash identifies the project,
 * then the issue is looked up within that project's file.
 *
 * Case-insensitive end to end: getProjectByPrefix already normalises case for
 * the project lookup, so the final key comparison must too, or a lowercase
 * key (which both models and humans will type) resolves the right project
 * and then fails to find the issue — stored keys are always canonical
 * (nextKey always builds `${prefix}-${n}` from an already-uppercased
 * prefix), so upper-casing both sides here is exact, not approximate.
 */
export function getIssue(key: string): Issue | undefined {
  const prefix = keyPrefix(key);
  if (!prefix) return undefined;
  const project = getProjectByPrefix(prefix);
  if (!project) return undefined;
  const target = key.toUpperCase();
  return loadIssues(project.id).find((i) => i.key.toUpperCase() === target);
}

/**
 * Persist an issue (insert or update by id) into its project's file.
 * Guards against a key already belonging to a *different* issue on disk —
 * should be unreachable in practice (buildIssue always allocates through
 * nextKey, and the update helpers below only ever round-trip an issue's own
 * existing key), but a hand-edited or corrupt-then-partially-recovered
 * issues file is exactly the kind of thing that already burned this repo
 * once (see job-storage.ts's create_job comment).
 */
export function saveIssue(issue: Issue): void {
  const file = safeIssuesFile(issue.projectId);
  // Unlike loadIssues (a read, where "unknown" and "empty" look the same),
  // this is a write: silently no-op-ing would be the same silent-success
  // shape the spec elsewhere complains about, so an unknown/unsafe projectId
  // throws instead of quietly discarding the issue.
  if (!file) throw new Error(`Unknown project "${issue.projectId}"`);

  const issues = loadIssues(issue.projectId);
  const idx = issues.findIndex((i) => i.id === issue.id);
  // Captured before the overwrite below: this is the "previous version by id"
  // phase 4 needs to detect a status transition, already sitting in memory
  // from the loadIssues() call above — no extra IO to get it.
  const previousStatus = idx >= 0 ? issues[idx].status : undefined;
  if (idx >= 0) {
    issues[idx] = issue;
  } else {
    const keyCollision = issues.find((i) => i.key === issue.key);
    if (keyCollision) {
      throw new Error(`Issue key "${issue.key}" already belongs to a different issue (${keyCollision.id})`);
    }
    issues.push(issue);
  }
  writeJsonAtomic(file, { issues });

  // Phase 4 (docs/internal/issue-tracker-spec.md): a job can trigger on an
  // issue entering a status. A brand new issue (previousStatus undefined)
  // always fires — a job watching Backlog for triage needs to see an issue
  // the moment it's created, not just a later move into Backlog — while an
  // update only fires when the status actually changed, so touching just the
  // title/description/labels/priority never spuriously retriggers a job.
  // Placed after writeJsonAtomic so a save that throws (unknown project, key
  // collision, a disk error) never emits for a change that was never persisted.
  if (previousStatus !== issue.status) {
    emitIssueStatusChange({ key: issue.key, projectId: issue.projectId, from: previousStatus, to: issue.status });
  }
}

/**
 * Remove an issue by its key. Returns false when the key resolves to nothing,
 * so a caller can answer 404 rather than pretend it deleted something.
 *
 * Deliberately permanent, and deliberately not offered to the MCP tools: a
 * status of Cancelled is how an agent or a job retires an issue, and a model
 * that can delete one can also destroy the record of why it did. This is a
 * human action from the UI.
 *
 * The key counter is NOT rewound. Deleting CK-12 leaves the next issue as
 * CK-13, because the key is how the issue is referred to in branches, PR
 * titles, worktree paths and other issues' comments, and handing the same key
 * to a different issue later would silently repoint all of them.
 */
export function deleteIssue(key: string): boolean {
  const prefix = keyPrefix(key);
  if (!prefix) return false;
  const project = getProjectByPrefix(prefix);
  if (!project) return false;
  const file = safeIssuesFile(project.id);
  if (!file) return false;

  const target = key.toUpperCase();
  const issues = loadIssues(project.id);
  const remaining = issues.filter((i) => i.key.toUpperCase() !== target);
  if (remaining.length === issues.length) return false;

  writeJsonAtomic(file, { issues: remaining });

  // Attachments are copied into cockpit's own store per issue key
  // (persistAttachmentFile), so they outlive the issue unless removed here.
  // Containment-checked before unlinking, same reasoning as deleteProject.
  try {
    const root = resolve(getIssueAttachmentsRoot());
    const dir = resolve(join(root, target));
    if (isContainedIn(root, dir) && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort: a stranded screenshot is not a reason to fail the delete
  }

  return true;
}

/**
 * Allocate the next issue key for a project (e.g. "CK-12") and persist the
 * advanced counter before returning, so the same number is never handed out
 * twice.
 *
 * Concurrency: this function is entirely synchronous (no `await` between the
 * read and the write), and Node runs one JS callback at a time, so two calls
 * from within this same process cannot interleave — the second call's read
 * only happens after the first call's write has completed. That covers the
 * realistic "two writes land close together" case, since cockpit runs as one
 * long-lived server process. It does not add cross-process file locking
 * (unlike job-lock.ts's job-run locking) — nothing else in this storage layer
 * does either, and a second, independent OS process writing `~/.cockpit`
 * concurrently isn't how this app runs.
 *
 * Separately, and regardless of *why* the counter and the file might disagree
 * (a hand-edited issues file, a restored backup, anything), this never hands
 * out a key that already exists: it checks the actual issues file and skips
 * forward past any collision before persisting.
 */
export function nextKey(projectId: string): string {
  const projects = loadProjects();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx < 0) throw new Error(`Unknown project "${projectId}"`);
  const project = projects[idx];

  const existingKeys = new Set(loadIssues(projectId).map((i) => i.key));
  let n = project.nextNumber || 1;
  let key = `${project.prefix}-${n}`;
  while (existingKeys.has(key)) {
    n++;
    key = `${project.prefix}-${n}`;
  }

  projects[idx] = { ...project, nextNumber: n + 1, updatedAt: Date.now() };
  writeJsonAtomic(projectsFile(), { projects });

  return key;
}

/** Everything a caller may supply when creating an issue. `key` is
 *  deliberately absent — nextKey() assigns it inside buildIssue(), so a
 *  caller has no way to construct an Issue with an arbitrary or colliding
 *  key. `status` is also absent: every new issue starts at "Backlog". */
export type IssueInput = {
  projectId: string;
  title: string;
  description?: string;
  priority?: 0 | 1 | 2 | 3 | 4;
  labels?: string[];
};

/**
 * Build a stored issue from caller input, allocating its key and seeding its
 * activity log with a "created" entry. One construction path: buildIssue and
 * applyIssueUpdate (plus addIssueComment/addIssueAttachment below) are the
 * only ways an Issue is created or changed, so the REST route and the MCP
 * tools (phase 2.3) cannot drift into building it two different ways — the
 * exact bug the spec's create_job comment describes. That controls *which*
 * fields get read; validating the *values* here closes the other half (see
 * the "Value validation" section above) — a caller can no longer end up with
 * a stored title of `12345` or a `priority` of `"critical"`.
 *
 * Validates before allocating a key, so a rejected create never burns a
 * number nextKey() would otherwise have to skip past later.
 */
export function buildIssue(input: IssueInput, actor: IssueActor): Issue {
  assertNonEmptyString(input.title, "title");
  if (input.description !== undefined) assertString(input.description, "description");
  if (input.priority !== undefined) assertValidPriority(input.priority);
  if (input.labels !== undefined) assertValidLabels(input.labels);

  const key = nextKey(input.projectId); // throws on an unknown project
  const now = Date.now();
  return {
    id: randomUUID(),
    key,
    projectId: input.projectId,
    title: input.title,
    description: input.description ?? "",
    status: "Backlog",
    priority: input.priority,
    labels: input.labels,
    createdAt: now,
    updatedAt: now,
    comments: [],
    attachments: [],
    activity: [{ id: randomUUID(), createdAt: now, actor, kind: "created" }],
  };
}

export type IssueUpdateInput = Partial<Pick<Issue, "title" | "description" | "status" | "priority" | "labels">>;

function sameLabels(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Apply a field-level patch (title/description/status/priority/labels) to an
 * issue, appending one activity entry per field that actually changed and
 * none at all when the patch is a no-op. Pure — does not persist; the caller
 * passes the result to saveIssue(). Storage never invents the actor: callers
 * (REST route, MCP tools) supply it, sourced from the token/session that made
 * the call.
 *
 * `priority`/`labels` use `"field" in patch` rather than `!== undefined` so an
 * explicit clear (set to undefined) is distinguishable from the field simply
 * being absent from the patch — both are optional Issue fields, so omission
 * and clearing would otherwise look identical. Validation below preserves
 * that: a present-but-`undefined` value is still a valid clear and is not
 * checked against assertValidPriority/assertValidLabels, only a present
 * *and-defined* value is.
 *
 * Every touched field is validated upfront, before any diffing/mutation
 * starts (and before the no-op short-circuit below), so a bad value throws
 * cleanly with no activity recorded and no partial patch applied — this is
 * the fix for the gap "one construction path" alone didn't close: it
 * controlled which fields a caller could touch, not whether the values were
 * any good, so a REST-shaped patch of `{ status: "Definitely Not A Status",
 * priority: "critical", labels: "not-an-array", title: 12345 }` used to be
 * stored verbatim.
 */
export function applyIssueUpdate(
  issue: Issue,
  patch: IssueUpdateInput,
  actor: IssueActor,
  allowedStatuses: readonly string[] = ISSUE_STATUSES,
): Issue {
  if (patch.title !== undefined) assertNonEmptyString(patch.title, "title");
  if (patch.description !== undefined) assertString(patch.description, "description");
  if (patch.status !== undefined) assertValidStatus(patch.status, allowedStatuses);
  if ("priority" in patch && patch.priority !== undefined) assertValidPriority(patch.priority);
  if ("labels" in patch && patch.labels !== undefined) assertValidLabels(patch.labels);

  const now = Date.now();
  const activity: IssueActivity[] = [];
  const next: Issue = { ...issue };

  function record(field: IssueActivity["field"], from: unknown, to: unknown): void {
    activity.push({ id: randomUUID(), createdAt: now, actor, kind: "field_changed", field, from, to });
  }

  if (patch.title !== undefined && patch.title !== issue.title) {
    next.title = patch.title;
    record("title", issue.title, patch.title);
  }
  if (patch.description !== undefined && patch.description !== issue.description) {
    next.description = patch.description;
    record("description", issue.description, patch.description);
  }
  if (patch.status !== undefined && patch.status !== issue.status) {
    next.status = patch.status;
    record("status", issue.status, patch.status);
  }
  if ("priority" in patch && patch.priority !== issue.priority) {
    next.priority = patch.priority;
    record("priority", issue.priority, patch.priority);
  }
  if ("labels" in patch && !sameLabels(issue.labels, patch.labels)) {
    next.labels = patch.labels;
    record("labels", issue.labels, patch.labels);
  }

  if (activity.length === 0) return issue; // no-op patch: no activity noise
  next.updatedAt = now;
  next.activity = [...issue.activity, ...activity];
  return next;
}

/**
 * Append a comment. Pure — does not persist; the caller passes the result to
 * saveIssue(). Shares applyIssueUpdate's shape: a "commented" activity entry
 * records who and when, the comment itself carries the body.
 */
export function addIssueComment(issue: Issue, body: string, actor: IssueActor): Issue {
  const now = Date.now();
  const comment: IssueComment = { id: randomUUID(), body, author: actor, createdAt: now };
  return {
    ...issue,
    comments: [...issue.comments, comment],
    updatedAt: now,
    activity: [...issue.activity, { id: randomUUID(), createdAt: now, actor, kind: "commented" }],
  };
}

/**
 * Copy a local attachment file into the issue-attachments root and return its
 * new absolute path; pass remote urls and already-rooted paths through
 * untouched.
 *
 * Callers hand us a path to a file they do not own the lifetime of. A session
 * attaching an image the user pasted into chat points at
 * ~/.cache/cockpit/attachments/<uuid>.jpg, which the PTY adapter deletes the
 * moment that session's next message is sent (claude-pty-adapter's
 * cleanupAttachments); the ui-reviewer's screenshots live in a temp dir it
 * rm -rf's at teardown. Storing the caller's path means storing a link that
 * works for minutes. Copying at attach time makes the attachment durable, and
 * lands it in the only directory the serving route will read from.
 */
export function persistAttachmentFile(issueKey: string, url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url; // remote: nothing to copy
  if (!url.startsWith("/")) throw new Error(`Attachment url must be an absolute path or a remote url: ${url}`);

  const root = resolve(getIssueAttachmentsRoot());
  const src = resolve(url);
  if (isContainedIn(root, src)) return src; // already durable (the ui-reviewer moves its own)
  if (!existsSync(src)) throw new Error(`Attachment file does not exist: ${url}`);

  const dir = join(root, issueKey.toUpperCase());
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${randomUUID()}${extname(src)}`);
  copyFileSync(src, dest);
  return dest;
}

/**
 * Append an attachment (the ui-reviewer agent's screenshots, mainly). Pure —
 * does not persist; the caller passes the result to saveIssue(). The url is
 * stored verbatim: run it through persistAttachmentFile first when it names a
 * local file the caller does not own.
 */
export function addIssueAttachment(issue: Issue, input: { title: string; url: string }, actor: IssueActor): Issue {
  const now = Date.now();
  const attachment: IssueAttachment = { id: randomUUID(), title: input.title, url: input.url, createdAt: now };
  return {
    ...issue,
    attachments: [...issue.attachments, attachment],
    updatedAt: now,
    activity: [...issue.activity, { id: randomUUID(), createdAt: now, actor, kind: "attachment_added" }],
  };
}
