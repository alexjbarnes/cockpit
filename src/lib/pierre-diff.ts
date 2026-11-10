import type { FileDiffMetadata } from "@pierre/diffs";

/**
 * Helpers for handing @pierre/diffs the full files behind a patch, so context
 * outside its hunks can be expanded. Kept out of the components so the edge
 * cases are testable: a file fetched while it is being rewritten does not
 * always match the patch that was fetched beside it.
 */

/** One entry per line, newline included. An empty file is no lines, and a
 *  trailing newline does not add a phantom blank one. */
export function splitFileLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => `${line}\n`);
}

/** Where a hunk side stops consuming its file, matching the boundary
 *  @pierre/diffs computes. */
function sideEnd(start: number, count: number): number {
  return start - (count === 0 ? 0 : 1) + count;
}

/**
 * Whether full contents are consistent with the patch's last hunk: each side
 * reaches the hunk's end, and whatever trails the hunk is the same length on
 * both sides. A diff read while the file was being truncated can fail this. If
 * it is marked complete anyway, @pierre/diffs throws a trailing-context error
 * while laying the diff out.
 */
export function contentsMatchHunks(meta: FileDiffMetadata, oldLineCount: number, newLineCount: number): boolean {
  const last = meta.hunks[meta.hunks.length - 1];
  if (!last) return false;
  const deletionEnd = sideEnd(last.deletionStart, last.deletionCount);
  const additionEnd = sideEnd(last.additionStart, last.additionCount);
  if (oldLineCount < deletionEnd || newLineCount < additionEnd) return false;
  return oldLineCount - deletionEnd === newLineCount - additionEnd;
}

/**
 * Replace a patch's parsed lines with the full file contents so the hunks can
 * expand into the rest of the file. Returns false, leaving the metadata as it
 * was, when the contents do not agree with the patch: the diff then still
 * renders, just without the expandable context.
 */
export function reindexForFullContent(meta: FileDiffMetadata, oldContent: string, newContent: string): boolean {
  const oldLines = splitFileLines(oldContent);
  const newLines = splitFileLines(newContent);
  if (!contentsMatchHunks(meta, oldLines.length, newLines.length)) return false;

  for (const hunk of meta.hunks) {
    const delDelta = hunk.deletionStart - 1 - hunk.deletionLineIndex;
    const addDelta = hunk.additionStart - 1 - hunk.additionLineIndex;
    hunk.deletionLineIndex = hunk.deletionStart - 1;
    hunk.additionLineIndex = hunk.additionStart - 1;
    for (const content of hunk.hunkContent) {
      content.deletionLineIndex += delDelta;
      content.additionLineIndex += addDelta;
    }
  }
  meta.deletionLines = oldLines;
  meta.additionLines = newLines;
  meta.isPartial = false;
  return true;
}
