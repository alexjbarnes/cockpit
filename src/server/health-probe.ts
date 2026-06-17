import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Decompose a stall: was the event loop blocked (synchronous work on the main
// thread — fix is to find/move the sync work), or is the loop free while file
// ops queue (fs thread-pool / disk contention — fix is fewer/cheaper fs ops)?
// loopLagMs = how late the fixed-interval timer fired (timer drift); a blocked
// loop can't fire timers, so it spikes. fsReadMs = a control read of a tiny file;
// it spikes when the libuv thread pool or disk is saturated while the loop is free.
const LOOP_THRESHOLD_MS = 200;
const FS_THRESHOLD_MS = 100;

export function classifyStall(loopLagMs: number, fsReadMs: number): string | null {
  if (loopLagMs <= LOOP_THRESHOLD_MS && fsReadMs <= FS_THRESHOLD_MS) return null;
  const cause =
    loopLagMs > fsReadMs
      ? "EVENT LOOP blocked — synchronous work on the main thread"
      : "fs thread-pool / disk contention — loop is free but file reads queue";
  return `[health] loopLag=${loopLagMs.toFixed(0)}ms fsRead=${fsReadMs.toFixed(0)}ms => ${cause}`;
}

/**
 * Lightweight watchdog that logs ONLY when the process stalls. Every interval it
 * measures timer drift (event-loop lag) and a control read of a tiny file on the
 * cockpit dir's disk, then classifies any spike. Low volume by design and
 * independent of COCKPIT_DEBUG, so it can run with debug logging OFF to tell
 * whether slow session switching is the event loop, fs/disk, or neither.
 */
export function startHealthProbe(dir: string, log: (m: string) => void = console.log, intervalMs = 500): () => void {
  const probeFile = path.join(dir, ".health-probe");
  writeFile(probeFile, "x").catch(() => {});
  let last = performance.now();
  let stopped = false;

  const timer = setInterval(() => {
    const now = performance.now();
    const loopLagMs = Math.max(0, now - last - intervalMs);
    last = now;
    const t0 = performance.now();
    readFile(probeFile, "utf-8")
      .catch(() => {})
      .then(() => {
        if (stopped) return;
        const line = classifyStall(loopLagMs, performance.now() - t0);
        if (line) log(line);
      });
  }, intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
