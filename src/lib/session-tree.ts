import type { GitStatus } from "@pierre/trees";

export type TreeGitStatus = GitStatus;

/** What GET /api/filesystem/tree answers for a directory. */
export interface SessionPathListing {
  paths: string[];
  ignored: string[];
  truncated: boolean;
}

/** The statuses the git API reports that the tree understands. */
export function toTreeGitStatus(status: string): TreeGitStatus {
  switch (status) {
    case "added":
    case "modified":
    case "deleted":
    case "ignored":
    case "renamed":
    case "untracked":
      return status;
    default:
      return "modified";
  }
}

/** The file a click just added to the selection. The tree reports the whole
 *  selection, not the row that changed, so the previous selection is needed to
 *  tell what to open. A modified multi-select still opens one file: the last
 *  new one. */
export function newlySelectedPath(previous: readonly string[], selected: readonly string[], files: ReadonlySet<string>): string | null {
  const before = new Set(previous);
  for (let i = selected.length - 1; i >= 0; i--) {
    const path = selected[i];
    if (!before.has(path) && files.has(path)) return path;
  }
  return null;
}

/** The `+N -M` shown beside a changed file in the tree. */
export function changeDecoration(file: { additions: number; deletions: number }): { text: string; title: string } | null {
  if (file.additions <= 0 && file.deletions <= 0) return null;
  const parts: string[] = [];
  if (file.additions > 0) parts.push(`+${file.additions}`);
  if (file.deletions > 0) parts.push(`-${file.deletions}`);
  const additions = `${file.additions} ${file.additions === 1 ? "addition" : "additions"}`;
  const deletions = `${file.deletions} ${file.deletions === 1 ? "deletion" : "deletions"}`;
  return { text: parts.join(" "), title: `${additions}, ${deletions}` };
}

/** A tree path is relative to the session directory; a file tab takes the
 *  absolute path. Matches how the Changes view opens a file for editing. */
export function absolutePath(cwd: string, relativePath: string): string {
  if (relativePath.startsWith("/")) return relativePath;
  return `${cwd.replace(/\/+$/, "")}/${relativePath}`;
}
