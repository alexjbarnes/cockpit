import path from "node:path";
import { readClaudeUserConfig, updateClaudeUserConfig } from "@/server/claude-user-config";

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
 * the PTY runtime is not). So the entry is written directly, before the spawn,
 * through the shared writer in claude-user-config.ts — cockpit is one of
 * several uncoordinated writers of that file, and its half of the write has to
 * be one a reader can never catch half-done.
 */

/** Whether the CLI already trusts `dir`, i.e. it will not raise its dialog. */
export function isDirectoryTrusted(dir: string): boolean {
  const read = readClaudeUserConfig();
  if (!read) return false;
  const projects = read.data.projects as Record<string, { hasTrustDialogAccepted?: boolean }> | undefined;
  return projects?.[path.resolve(dir)]?.hasTrustDialogAccepted === true;
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
  const key = path.resolve(dir);
  return updateClaudeUserConfig((data) => {
    const projects = (data.projects ?? {}) as Record<string, Record<string, unknown>>;
    const existing = projects[key];
    // Merge rather than replace: an entry can already exist carrying the CLI's
    // own per-project state (allowed tools, MCP server choices, last-run
    // stats), and only the trust flag is ours to set.
    if (existing?.hasTrustDialogAccepted === true) return false;
    projects[key] = { ...(existing ?? {}), hasTrustDialogAccepted: true };
    data.projects = projects;
    return true;
  });
}
