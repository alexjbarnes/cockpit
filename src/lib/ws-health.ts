// When the page's websocket counts as dead. A phone tests this hardest: a new
// connection can take seconds to open over a waking radio or a VPN, and a pong
// arrives behind whatever the server sent before it, which can be a transcript
// update of hundreds of KB. Judging either by a two-second clock tore down
// working connections, and a socket still opening was replaced every three
// seconds, so a slow link never got connected at all.

/** How long a new socket may take to open before it is given up on. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** How long a ping may go unanswered, with nothing else received either. */
export const PONG_TIMEOUT_MS = 5_000;

// WebSocket.readyState values, spelled out so this module runs without a DOM.
const CONNECTING = 0;
const OPEN = 1;

export type SocketHealth = "open" | "opening" | "dead";

/** What the health check makes of a socket created at `createdAt`. */
export function socketHealth(readyState: number, createdAt: number, now: number): SocketHealth {
  if (readyState === OPEN) return "open";
  if (readyState === CONNECTING && now - createdAt < CONNECT_TIMEOUT_MS) return "opening";
  return "dead";
}

/** At the pong deadline: anything received since the ping shows the socket is
 *  alive, its pong just queued behind it. */
export function aliveAtPongDeadline(pingSentAt: number, lastReceivedAt: number): boolean {
  return lastReceivedAt >= pingSentAt;
}

/** How long a phone can be in the background before its socket is replaced on
 *  return rather than tested. In the debug log, a phone back within 5 s kept
 *  its socket 66 times out of 68, and one away 15 s or more lost it 18 times
 *  out of 19. */
export const RESUME_RECONNECT_MS = 10_000;

/** Whether to replace the socket straight away on coming back from the
 *  background. Testing a dead one costs the whole pong timeout before the
 *  reconnect even starts. A desktop keeps its socket, so it is tested. */
export function replaceOnResume(hiddenForMs: number, coarsePointer: boolean): boolean {
  return coarsePointer && hiddenForMs >= RESUME_RECONNECT_MS;
}
