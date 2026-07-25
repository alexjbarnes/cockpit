import { expect, vi } from "vitest";

// Linux `fs.watch(dir, {recursive: true})` arms asynchronously: the call
// returns before the recursive walk has finished subscribing, and anything
// written in that window is never reported at all. Tests that created a
// watcher and immediately wrote a file were therefore racing the runtime —
// they passed on an idle machine and failed under load, and waiting longer
// afterwards could not help, because the event was never queued in the first
// place. The fix is to keep touching until the watcher proves it is live.

/** Default ceiling for arming. Generous: a loaded machine can take seconds. */
const ARM_TIMEOUT_MS = 15_000;
/** Slower than fs-watcher's 500ms debounce so each touch gets a fair chance
 *  to be reported before the next one. */
const TOUCH_INTERVAL_MS = 600;
/** Long enough for a debounce started by the arming touch to have fired. */
const DRAIN_MS = 900;

/**
 * Repeatedly run `touch` until `fired` reports the watcher delivered
 * something. Returns once the watch is demonstrably live, so assertions after
 * this point are testing behaviour rather than startup timing.
 */
export async function armWatcher(touch: () => void, fired: () => boolean, timeoutMs = ARM_TIMEOUT_MS): Promise<void> {
  await vi.waitFor(
    () => {
      touch();
      expect(fired()).toBe(true);
    },
    { timeout: timeoutMs, interval: TOUCH_INTERVAL_MS },
  );
  // The touch that armed the watch may have left a debounce timer running.
  // Draining it here means a caller that clears its spy straight after gets a
  // genuinely clean slate, rather than catching this arming write late and
  // attributing it to whatever it goes on to test.
  await new Promise((resolve) => setTimeout(resolve, DRAIN_MS));
}
