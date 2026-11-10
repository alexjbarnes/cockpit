// Handing @pierre/diffs the full files behind a patch: the line splitting and
// the consistency guard that keeps a diff read mid-write from crashing layout
// with "trailing context mismatch".
import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { contentsMatchHunks, reindexForFullContent, splitFileLines } from "@/lib/pierre-diff";

interface Hunk {
  deletionStart: number;
  deletionCount: number;
  additionStart: number;
  additionCount: number;
  hunkContent?: { deletionLineIndex: number; additionLineIndex: number }[];
}

function meta(hunks: Hunk[], isPartial = true): FileDiffMetadata {
  return {
    name: "package.json",
    hunks: hunks.map((h) => ({
      ...h,
      deletionLineIndex: 0,
      additionLineIndex: 0,
      hunkContent: h.hunkContent ?? [],
    })),
    deletionLines: [],
    additionLines: [],
    isPartial,
  } as unknown as FileDiffMetadata;
}

describe("splitFileLines", () => {
  it("returns no lines for an empty file", () => {
    expect(splitFileLines("")).toEqual([]);
  });

  it("keeps one entry per line without a phantom trailing one", () => {
    expect(splitFileLines("a\nb\n")).toEqual(["a\n", "b\n"]);
    expect(splitFileLines("a\nb")).toEqual(["a\n", "b\n"]);
    // Line endings are normalised, as the diff renderer expects.
    expect(splitFileLines("a\r\nb\r\n")).toEqual(["a\n", "b\n"]);
  });
});

describe("contentsMatchHunks", () => {
  it("accepts equal trailing context on both sides", () => {
    // @@ -1,3 +1,3 @@ with 190 lines on each side: 187 trail the hunk.
    expect(contentsMatchHunks(meta([{ deletionStart: 1, deletionCount: 3, additionStart: 1, additionCount: 3 }]), 190, 190)).toBe(true);
  });

  it("rejects contents that do not have the same trailing run, as a mid-write read does", () => {
    // The reported shape: the patch covers the first three lines, the file read
    // back had already been truncated to those three, leaving 187 old lines
    // unmatched.
    expect(contentsMatchHunks(meta([{ deletionStart: 1, deletionCount: 3, additionStart: 1, additionCount: 3 }]), 190, 3)).toBe(false);
  });

  it("rejects a hunk that reaches past the content, and a patch with no hunks", () => {
    expect(contentsMatchHunks(meta([{ deletionStart: 1, deletionCount: 3, additionStart: 1, additionCount: 3 }]), 1, 1)).toBe(false);
    expect(contentsMatchHunks(meta([]), 10, 10)).toBe(false);
  });

  it("accepts a deletion-only hunk whose new side is empty", () => {
    expect(contentsMatchHunks(meta([{ deletionStart: 1, deletionCount: 187, additionStart: 0, additionCount: 0 }]), 187, 0)).toBe(true);
  });
});

describe("reindexForFullContent", () => {
  it("replaces the patch's lines and rebases hunk indices when the contents match", () => {
    const fileDiff = meta([
      {
        deletionStart: 5,
        deletionCount: 2,
        additionStart: 5,
        additionCount: 2,
        hunkContent: [{ deletionLineIndex: 0, additionLineIndex: 0 }],
      },
    ]);
    expect(reindexForFullContent(fileDiff, "a\nb\nc\nd\ne\nf\n", "a\nb\nc\nd\ne\nX\n")).toBe(true);
    expect(fileDiff.deletionLines).toHaveLength(6);
    expect(fileDiff.additionLines).toHaveLength(6);
    expect(fileDiff.isPartial).toBe(false);
    expect(fileDiff.hunks[0].deletionLineIndex).toBe(4);
    expect(fileDiff.hunks[0].hunkContent[0].deletionLineIndex).toBe(4);
  });

  it("leaves the metadata alone when the contents do not match the patch", () => {
    const fileDiff = meta([{ deletionStart: 1, deletionCount: 3, additionStart: 1, additionCount: 3 }]);
    expect(reindexForFullContent(fileDiff, "a\nb\nc\nd\ne\nf\n", "a\n")).toBe(false);
    expect(fileDiff.deletionLines).toEqual([]);
    expect(fileDiff.additionLines).toEqual([]);
    expect(fileDiff.isPartial).toBe(true);
  });

  it("handles a file emptied down to nothing", () => {
    const fileDiff = meta([{ deletionStart: 1, deletionCount: 2, additionStart: 0, additionCount: 0 }]);
    expect(reindexForFullContent(fileDiff, "a\nb\n", "")).toBe(true);
    expect(fileDiff.deletionLines).toEqual(["a\n", "b\n"]);
    expect(fileDiff.additionLines).toEqual([]);
  });
});
