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

const emitter = new EventEmitter();
const EVENT = "status-change";

export function emitIssueStatusChange(event: IssueStatusChangeEvent): void {
  emitter.emit(EVENT, event);
}

/** Subscribe to every issue status change. Returns an unsubscribe function. */
export function onIssueStatusChange(listener: (event: IssueStatusChangeEvent) => void): () => void {
  emitter.on(EVENT, listener);
  return () => emitter.off(EVENT, listener);
}
