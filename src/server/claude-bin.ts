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

/** Memoised per resolved binary, so a `claude` self-update re-probes. */
let permissionModeCache: { bin: string; modes: Set<string> } | null = null;

/**
 * The `--permission-mode` values this `claude` build accepts, read from its
 * own `--help`.
 *
 * Needed because the mode names are not stable across CLI versions: what used
 * to be the unnamed default is now `manual`, and `auto` was added alongside it.
 * Cockpit has to ask for a mode explicitly (see the adapter — the CLI's own
 * default became `auto`, whose safety classifier runs on the SESSION's model
 * and times out on a slow non-Anthropic one, blocking every tool call), but
 * passing a name an older build does not know is fatal: the CLI rejects the
 * choice and the spawn dies. So ask first, and fall back to passing nothing.
 *
 * An unreadable `--help` yields an empty set, i.e. "assume nothing is
 * supported", which restores exactly the pre-existing no-flag behaviour.
 */
export function supportedPermissionModes(): Set<string> {
  const bin = getClaudeBin();
  if (permissionModeCache?.bin === bin) return permissionModeCache.modes;
  const modes = new Set<string>();
  try {
    const help = execFileSync(bin, ["--help"], { encoding: "utf-8", timeout: 10_000 });
    // The help renders the list as: --permission-mode <mode>  ... (choices:
    // "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")
    // wrapped across lines, so match the whole block then pull the quoted names.
    const block = help.slice(help.indexOf("--permission-mode"));
    const choices = block.slice(0, block.indexOf(")") + 1).match(/"([a-zA-Z]+)"/g);
    for (const raw of choices ?? []) modes.add(raw.replaceAll('"', ""));
  } catch {
    // Leave the set empty: no flag is passed, which is what cockpit did before.
  }
  permissionModeCache = { bin, modes };
  return modes;
}
