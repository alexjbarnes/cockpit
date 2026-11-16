import { EventEmitter } from "node:events";

/**
 * Fired by issue-storage.ts's saveIssue whenever an issue's status changes,
 * including a brand-new issue arriving in its initial status (`from` is
 * absent in that case). job-scheduler.ts subscribes to this to drive the
 * onIssueStatus job trigger (docs/internal/issue-tracker-spec.md phase 4).
 *
 * Deliberately a standalone module rather than living in issue-storage.ts or
 * job-scheduler.ts directly: storage must never import the scheduler
 * (dependency direction is scheduler -> storage, never back), so the emitter
 * lives in its own leaf module that both sides import without creating a
 * cycle.
 */
export interface IssueStatusChangeEvent {
  key: string;
  projectId: string;
  /** Absent for a newly created issue — there is no "previous" status. A
   *  built-in status or a project custom status (string, not IssueStatus). */
  from?: string;
  to: string;
}

/**
 * One emitter for the whole process, kept on globalThis. The server's own
 * modules and the route handlers are built separately, so each has its own
 * copy of this file: with a module-level emitter, a status changed through a
 * route (the issue page, the board) was emitted on one copy while the
 * scheduler and the workflow engine listened on the other, and never heard it.
 */
const EMITTER_KEY = "__cockpit_issue_events__";
function shared(): EventEmitter {
  const g = globalThis as Record<string, unknown>;
  if (!g[EMITTER_KEY]) g[EMITTER_KEY] = new EventEmitter();
  return g[EMITTER_KEY] as EventEmitter;
}

const emitter = shared();
const EVENT = "status-change";

export function emitIssueStatusChange(event: IssueStatusChangeEvent): void {
  emitter.emit(EVENT, event);
}

/** Subscribe to every issue status change. Returns an unsubscribe function. */
export function onIssueStatusChange(listener: (event: IssueStatusChangeEvent) => void): () => void {
  emitter.on(EVENT, listener);
  return () => emitter.off(EVENT, listener);
}
