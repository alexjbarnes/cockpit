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
  sessionId: string | null;
  visible: boolean;
}

const viewers = new Map<string, Viewer>();

/** One client's state. `clientKey` is the connection's own id. */
export function setViewer(clientKey: string, sessionId: string | null, visible: boolean): void {
  if (!sessionId) {
    viewers.delete(clientKey);
    return;
  }
  viewers.set(clientKey, { sessionId, visible });
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
    if (viewer.sessionId === sessionId && viewer.visible) return true;
  }
  return false;
}

/** Testing seam. */
export function resetViewers(): void {
  viewers.clear();
}
