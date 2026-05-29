// Force-cleanup of orphaned integration-test processes.
//
// The harness spawns cockpit detached (its own process group) and kills the
// group in stop(). That covers the normal path. It does NOT cover a run killed
// mid-flight (Ctrl-C, OOM, crash, `playwright test` interrupted) — then stop()
// never runs and cockpit + every claude/bridge child it spawned leak. Across
// runs these pile up and can wedge the box.
//
// This reaper finds them by scanning /proc/<pid>/environ for the config-dir env
// var the harness sets to a tmpdir under `cockpit-it-`. Because cockpit passes
// its full env to the CLI children (and the CLI to the hook bridge), every
// process in the tree inherits it — one scan catches the whole tree. Matching
// on the environment is the key: `pgrep -f` only sees argv (`node dist/server.js`),
// never the env var, so a cmdline match can't find these.
//
// The marker is specific to test tmpdirs (`/cockpit-it-`), so a developer's real
// cockpit (`~/.cockpit`) and live CLI sessions are never matched.

import { readdirSync, readFileSync } from "node:fs";

const MARKER = "/cockpit-it-";
const CONFIG_KEYS = ["COCKPIT_CONFIG_DIR=", "CLAUDE_CONFIG_DIR="];

/**
 * SIGKILL every process whose COCKPIT_CONFIG_DIR/CLAUDE_CONFIG_DIR points at an
 * integration tmpdir. Returns the number killed. Best-effort and safe to call
 * when nothing is leaked (returns 0). No-ops on platforms without /proc.
 */
export function reapIntegrationOrphans(log: (msg: string) => void = () => {}): number {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    // No /proc (macOS, etc). The harness's own process-group kill is the only
    // cleanup available there; nothing more we can do generically.
    return 0;
  }

  const self = process.pid;
  const victims: number[] = [];

  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === self || pid === process.ppid) continue;

    let environ: string;
    try {
      environ = readFileSync(`/proc/${pid}/environ`, "utf-8");
    } catch {
      // Process exited between readdir and read, or not ours (EACCES). Skip.
      continue;
    }

    const matched = environ.split("\0").some((kv) => CONFIG_KEYS.some((k) => kv.startsWith(k)) && kv.includes(MARKER));
    if (matched) victims.push(pid);
  }

  let killed = 0;
  for (const pid of victims) {
    try {
      process.kill(pid, "SIGKILL");
      killed++;
    } catch {
      // Already gone.
    }
  }

  if (killed > 0) log(`[integration] reaped ${killed} orphan process(es) under ${MARKER}`);
  return killed;
}
