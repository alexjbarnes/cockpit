import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

let resolvedClaudeBin: string | null = null;

/**
 * Resolve the `claude` executable path and cache it for the process.
 *
 * The cache is invalidated when the resolved absolute path no longer exists, so
 * a `claude` self-update that deletes the old versioned binary out from under a
 * long-running server is picked up on the next spawn instead of wedging every
 * session with `execvp: No such file or directory` until a manual restart.
 * `existsSync` follows symlinks, so a stable launcher symlink the updater
 * repoints stays valid; only a cached path to a now-deleted binary re-resolves.
 * The bare-name PATH fallback is left cached as-is — it has no fixed path to
 * validate and exec-time PATH resolution handles it.
 */
export function getClaudeBin(): string {
  if (resolvedClaudeBin && (!isAbsolute(resolvedClaudeBin) || existsSync(resolvedClaudeBin))) {
    return resolvedClaudeBin;
  }
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    resolvedClaudeBin = execFileSync(cmd, ["claude"], { encoding: "utf-8" }).trim().split("\n")[0];
  } catch {
    resolvedClaudeBin = "claude";
  }
  return resolvedClaudeBin;
}
