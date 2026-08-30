import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getClaudeUserConfigFile } from "@/server/paths";

/**
 * Pre-accept the CLI's workspace-trust dialog for a directory cockpit is about
 * to run in unattended.
 *
 * The CLI raises "Is this a project you created or one you trust?" the first
 * time it runs in a directory, and cockpit cannot answer it: it types blind,
 * and neither Enter nor the arrow keys dismiss it (both measured against CLI
 * 2.1.248). What happened instead was that start() typed the whole prompt into
 * the dialog, the CLI exited 1 under a second, and the scheduled job reported
 * "went idle without producing any assistant message" with no transcript — a
 * job that had run fine for weeks, on a directory that had quietly lost its
 * trust entry. Diagnosing that took a debug-log dig and a PTY probe, because
 * nothing in the failure mentions trust.
 *
 * Trust lives in the CLI's own `~/.claude.json` under
 * `projects[dir].hasTrustDialogAccepted`; there is no flag or settings key that
 * pre-grants it (the dialog is only skipped in non-interactive `-p` mode, which
 * the PTY runtime is not). So the entry is written directly, before the spawn.
 */

/** Whether the CLI already trusts `dir`, i.e. it will not raise its dialog. */
export function isDirectoryTrusted(dir: string): boolean {
  const file = getClaudeUserConfigFile();
  if (!existsSync(file)) return false;
  try {
    const config = JSON.parse(readFileSync(file, "utf-8")) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
    return config.projects?.[path.resolve(dir)]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
}

/**
 * Record trust for a directory, on the user's say-so.
 *
 * Two callers, both of which are that say-so: the "Trust this directory"
 * button on a session that could not start, and a scheduled job about to run
 * in a directory its author chose. Neither is cockpit deciding for itself, so
 * there is no fence here — the caller owns the decision.
 *
 * A job used to be fenced to cockpit's own scratchpads, on the reasoning that
 * a job's own cwd points at the user's real code. That was the wrong line: a
 * job runs unattended, so refusing to start leaves it failing every run with
 * nobody to answer, and configuring the job to run an agent with tools in that
 * directory is a far larger grant than trust already.
 */
export function trustDirectory(dir: string): boolean {
  return writeTrustEntry(dir);
}

function writeTrustEntry(dir: string): boolean {
  const file = getClaudeUserConfigFile();
  if (!existsSync(file)) return false;

  try {
    const config = JSON.parse(readFileSync(file, "utf-8")) as {
      projects?: Record<string, Record<string, unknown>>;
    };
    const key = path.resolve(dir);
    if (!config.projects) config.projects = {};
    const projects = config.projects;
    const existing = projects[key];
    if (existing?.hasTrustDialogAccepted === true) return false;

    // Merge rather than replace: an entry can already exist carrying the CLI's
    // own per-project state (allowed tools, MCP server choices, last-run
    // stats), and only the trust flag is ours to set.
    projects[key] = { ...(existing ?? {}), hasTrustDialogAccepted: true };

    // Written in place, NOT through writeJsonAtomic: ~/.claude.json can be its
    // own mount (it is on this developer's box), and a rename onto a mount
    // point fails with EBUSY. The file is small and this only runs when the
    // flag is genuinely missing, so the truncate window is narrow and rare.
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    return true;
  } catch {
    // A config we cannot read or write is not worth failing a spawn over; the
    // job proceeds and, at worst, hits the dialog as before.
    return false;
  }
}
