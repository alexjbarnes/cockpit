// Runs once before the integration suite. Reaps any orphaned cockpit/CLI
// processes left by a previous run that died without tearing down (killed
// mid-test, OOM, machine paged). Without this, leftovers compound across runs
// and can wedge the box.
//
// See reap.ts for why this scans /proc environ instead of pgrep-ing argv (the
// old pgrep -f approach never matched: the marker lives in the env, not argv).

import { reapIntegrationOrphans } from "./reap";

export default function globalSetup(): void {
  reapIntegrationOrphans((msg) => console.log(msg));
}
