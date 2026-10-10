import { EventEmitter } from "node:events";

/**
 * A session needs the user: a turn ended, a question is waiting, or a tool
 * call is waiting for approval. Emitted by session-manager at the three
 * moments it notices, and consumed by ws-handler, which sends it to every
 * connected socket as `session:attention` so a client can raise a banner
 * without being the session on screen.
 *
 * A leaf module for the same reason issue-events.ts is one: session-manager
 * must not import ws-handler (ws-handler already imports session-manager), so
 * the emitter lives where both can reach it without a cycle.
 */
export interface SessionAttentionEvent {
  sessionId: string;
  name: string;
  cwd: string;
  kind: "finished" | "question" | "permission";
  /** Set for question and permission: what the user would be answering. */
  requestId?: string;
  toolName?: string;
  /** The permission request's raw tool input, JSON, as `permission:request`
   *  carries it, so a banner can describe the command the same way the card
   *  does. */
  input?: string;
}

const emitter = new EventEmitter();
// One subscriber per websocket handler, and a test file builds several, each
// with its own listeners until its server closes; the default cap of 10 is
// about a single emitter's real leak, which this is not.
emitter.setMaxListeners(0);
const EVENT = "attention";

export function emitSessionAttention(event: SessionAttentionEvent): void {
  emitter.emit(EVENT, event);
}

/** Subscribe to every attention event. Returns an unsubscribe function. */
export function onSessionAttention(listener: (event: SessionAttentionEvent) => void): () => void {
  emitter.on(EVENT, listener);
  return () => emitter.off(EVENT, listener);
}

/**
 * A pending request is gone, however it went: answered in a tab, answered from
 * a notification, or dropped when its turn ended. Broadcast like the attention
 * events rather than sent only to the session's watchers, because the banner
 * raised for it is on the screen of someone looking at a *different* session.
 */
const RESOLVED_EVENT = "request-resolved";

export function emitSessionRequestResolved(sessionId: string, requestId: string): void {
  emitter.emit(RESOLVED_EVENT, sessionId, requestId);
}

export function onSessionRequestResolved(listener: (sessionId: string, requestId: string) => void): () => void {
  emitter.on(RESOLVED_EVENT, listener);
  return () => emitter.off(RESOLVED_EVENT, listener);
}
