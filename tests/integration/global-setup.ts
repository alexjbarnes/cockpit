// Defensive cleanup that runs before the suite. If a previous run died
// without tearing down its cockpit/CLI children (test killed mid-test,
// machine paged, OS swapped out), this kills the leftovers so they don't
// compound across runs.
//
// We scope by the test-only env vars we set in spawnCockpit:
//   - cockpit servers have `COCKPIT_CONFIG_DIR=/tmp/cockpit-it-*`
//   - CLI children inherit that env from cockpit
// Matching on the config dir path avoids touching the developer's own
// running cockpit dev server.

import { execSync } from "node:child_process";

export default function globalSetup(): void {
  try {
    // pgrep -af matches the full command line including env-exported vars
    // shown via /proc. Fall back to a no-op if pgrep isn't available or
    // nothing matches.
    const pids = execSync("pgrep -af 'cockpit-it-[A-Za-z0-9]+' || true", { encoding: "utf-8" })
      .split("\n")
      .map((line) => line.split(" ")[0])
      .filter(Boolean);

    if (pids.length === 0) return;
    console.log(`[integration] reaping ${pids.length} leftover test processes:`, pids);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // already gone
      }
    }
  } catch {
    // pgrep missing or other issue — proceed regardless
  }
}
