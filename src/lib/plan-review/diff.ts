// What changed between two versions of a plan, in the two forms the review
// surface needs: which lines of the newer text are new or rewritten (to mark
// them in the rendered plan), and a patch of a reviewer's own edits (to send
// with their feedback).

import { createTwoFilesPatch, diffLines } from "diff";

/**
 * The 1-based lines of `next` that are not in `previous`. A line that was
 * only removed leaves nothing to mark in the newer text, so the line after
 * the gap is marked instead: something went from just above it.
 */
export function changedLines(previous: string, next: string): Set<number> {
  const changed = new Set<number>();
  if (previous === next) return changed;
  const total = next === "" ? 0 : next.replace(/\n$/, "").split("\n").length;
  let line = 1;
  for (const part of diffLines(previous, next)) {
    const count = part.count ?? 0;
    if (part.added) {
      for (let i = 0; i < count; i++) changed.add(line + i);
      line += count;
    } else if (part.removed) {
      if (total > 0) changed.add(Math.min(line, total));
    } else {
      line += count;
    }
  }
  return changed;
}

/** How much changed, for a one-line summary beside a version. */
export function changeSummary(previous: string, next: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(previous, next)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

/** A unified diff of a reviewer's edits, without the file header lines, or
 *  an empty string when they changed nothing. */
export function planEditDiff(original: string, edited: string): string {
  if (original === edited) return "";
  const patch = createTwoFilesPatch("plan", "plan", original, edited, "", "", { context: 2 });
  const at = patch.indexOf("@@");
  return at === -1 ? "" : patch.slice(at).trimEnd();
}
