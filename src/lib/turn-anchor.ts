/**
 * Where the live turn counter beside the spinner counts from, on this device's
 * clock. Latched once per turn by the chat view; see there for why.
 *
 * In order of trust:
 *  - `serverTurnStartedAt`, set when a page connects mid-turn. The server says
 *    how long the turn has run since the user's message was delivered, so it
 *    holds however long the turn is: the message itself may sit outside the 50
 *    messages the view renders, or outside the tail of the transcript the
 *    server loaded at all, and reading it from there restarted the counter
 *    from now every time the page was left and reopened.
 *  - `lastUserMessageAt`, the newest user message the page holds. Its clock is
 *    the device's own for a bubble added on send, the server's for one read
 *    back from the transcript, so a time in the future is treated as unusable.
 *  - `now`, when neither is available.
 */
export function turnStartAnchor(serverTurnStartedAt: number | null, lastUserMessageAt: number | null, now: number): number {
  if (serverTurnStartedAt != null) return Math.min(serverTurnStartedAt, now);
  if (lastUserMessageAt != null && lastUserMessageAt <= now) return lastUserMessageAt;
  return now;
}

/** Convert the server's "turn has run this long" into a start time on this
 *  device's clock. Elapsed is what crosses the wire, not a timestamp, so a
 *  difference between the two machines' clocks cannot skew the result. */
export function turnStartFromElapsed(elapsedMs: number, now: number): number {
  return now - Math.max(0, elapsedMs);
}
