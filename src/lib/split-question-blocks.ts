import type { ContentBlock } from "@/types";

export interface SplitResult {
  /** Blocks before the first AskUserQuestion */
  before: ContentBlock[];
  /** The AskUserQuestion tool_use block, if found */
  questionBlock: (ContentBlock & { type: "tool_use" }) | null;
  /** Blocks after the first AskUserQuestion (excluding additional AskUserQuestion blocks) */
  after: ContentBlock[];
}

/**
 * Splits a blocks array at the first AskUserQuestion tool_use block.
 * Returns the blocks before, the question block itself, and the blocks after.
 * Additional AskUserQuestion blocks in `after` are filtered out.
 */
export function splitAtQuestion(blocks: ContentBlock[]): SplitResult {
  const qIdx = blocks.findIndex((b) => b.type === "tool_use" && b.toolUse.name === "AskUserQuestion");

  if (qIdx < 0) {
    return { before: blocks, questionBlock: null, after: [] };
  }

  const questionBlock = blocks[qIdx] as ContentBlock & { type: "tool_use" };

  return {
    before: blocks.slice(0, qIdx),
    questionBlock,
    after: blocks.slice(qIdx + 1).filter((b) => !(b.type === "tool_use" && b.toolUse.name === "AskUserQuestion")),
  };
}
