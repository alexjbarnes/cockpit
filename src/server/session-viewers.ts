/**
 * Who is looking at which session right now, so a notification can skip the
 * session the user is already watching. A client reports this itself: the
 * server knows a socket is *connected* to a session long after the page moved
 * on (the connect subscription is never torn down), so connection is not
 * viewing, and visibility is a thing only the document knows.
 *
 * A leaf module, like issue-events/session-attention: ws-handler writes to it
 * (the sockets are its), session-notify reads it (the notifications are its),
 * and neither imports the other.
 */
interface Viewer {
  /** The session whose page this client is on, if any. */
  sessionId: string | null;
  /** Sessions open in a read-only peek over another page. */
  peeks: Set<string>;
  visible: boolean;
}

const viewers = new Map<string, Viewer>();

/** One client's state. `clientKey` is the connection's own id. */
export function setViewer(clientKey: string, sessionId: string | null, visible: boolean): void {
  if (!sessionId) {
    // Leaving the session page: the peek, if one is open, still owns whether
    // this client is looking at anything, so the flag is left alone.
    const existing = viewers.get(clientKey);
    if (existing) existing.sessionId = null;
    return;
  }
  const existing = viewers.get(clientKey);
  if (existing) {
    existing.sessionId = sessionId;
    existing.visible = visible;
  } else {
    viewers.set(clientKey, { sessionId, peeks: new Set(), visible });
  }
}

/** A peek at a session over another page counts as looking at it too, so a
 *  turn ending while it is open does not raise the banner or a push. */
export function setPeeking(clientKey: string, sessionId: string, peeking: boolean): void {
  const viewer = viewers.get(clientKey) ?? { sessionId: null, peeks: new Set<string>(), visible: true };
  if (peeking) viewer.peeks.add(sessionId);
  else viewer.peeks.delete(sessionId);
  if (!viewer.sessionId && viewer.peeks.size === 0) viewers.delete(clientKey);
  else viewers.set(clientKey, viewer);
}

/** Called when a connection closes: whatever it was watching, it is not now. */
export function forgetViewer(clientKey: string): void {
  viewers.delete(clientKey);
}

/**
 * True when a *visible* client is looking at this session. A tab in the
 * background, or a phone with the screen off, is not looking — the
 * notification is exactly what it is for.
 */
export function isSessionViewed(sessionId: string): boolean {
  for (const viewer of viewers.values()) {
    if (viewer.visible && (viewer.sessionId === sessionId || viewer.peeks.has(sessionId))) return true;
  }
  return false;
}

/** Testing seam. */
export function resetViewers(): void {
  viewers.clear();
}
