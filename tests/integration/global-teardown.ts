// Runs once after the integration suite. The per-test harness kills its own
// process group in stop(), so a clean run leaves nothing. This is the backstop
// for the cases stop() can't cover: a worker that crashed, a test that timed
// out hard, or a harness whose teardown threw. Reaping here means a failed run
// doesn't leave processes for the NEXT run (or the developer's machine) to
// inherit.

import { reapIntegrationOrphans } from "./reap";

export default function globalTeardown(): void {
  reapIntegrationOrphans((msg) => console.log(msg));
}
