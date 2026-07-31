import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write `value` to `file` as pretty-printed JSON, atomically.
 *
 * Write-then-rename instead of writing the real path directly: a rename
 * within the same directory is atomic, so a process killed mid-write (e.g. a
 * Mac force-quit/lid-close, or a crash) can never leave `file` holding
 * truncated/partial JSON that wipes whatever it stored on the next load().
 *
 * Extracted from session-prefs.ts, the one place in the repo that already did
 * this. job-storage.ts and inbox.ts still truncate-and-write-in-place, which
 * is why a `~/.cockpit` that hit that window ends up with `.bak.*` recovery
 * copies next to `scheduled-jobs.json` — every new issue/project write goes
 * through here instead.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}
