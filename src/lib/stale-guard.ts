/**
 * Latest-run-wins guard for an async routine that writes shared state.
 *
 * Two runs of the same fetch-then-render routine overlap far more often than it
 * looks: an effect that depends on several values fires more than once, and a
 * request whose latency varies (the sidebar's by-ids does a transcript scan that
 * grows with the number of pinned sessions) can land out of order. Without a
 * guard the LAST RESPONSE wins rather than the last request, so an older run
 * quietly overwrites a newer one's result — which is how a freshly created
 * session appeared in the sidebar and then vanished again until a page refresh.
 *
 * Call `begin()` when a run starts and check the returned predicate after every
 * await. Once a later run has begun, the earlier run's predicate reports stale
 * and it should drop its result instead of applying it.
 */
export interface StaleGuard {
  begin(): () => boolean;
}

export function createStaleGuard(): StaleGuard {
  let latest = 0;
  return {
    begin() {
      const seq = ++latest;
      return () => seq !== latest;
    },
  };
}
