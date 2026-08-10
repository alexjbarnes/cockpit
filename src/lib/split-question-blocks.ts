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
/**
 * Which pending question each message's unanswered question block should show:
 * message id -> index into the unanswered pending requests, in message order.
 *
 * The nth unanswered block pairs with the nth unanswered request. Binding every
 * block to the first unanswered request instead rendered one request as several
 * identical cards — each with its own selection, so choosing in one left the
 * others blank — and a second question was never reachable because both cards
 * showed the first. A block with no request left to pair with maps to nothing:
 * there is no request behind it to answer.
 */
export function pairQuestionBlocks(messages: { id: string; role: string; blocks?: ContentBlock[] }[]): Map<string, number> {
  const pairing = new Map<string, number>();
  let next = 0;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const { questionBlock } = splitAtQuestion(message.blocks || []);
    if (!questionBlock || questionBlock.toolUse.output) continue;
    // A message id can repeat when the same turn arrives twice (a streaming
    // copy alongside the finalized one); the first occurrence keeps the request.
    if (pairing.has(message.id)) continue;
    pairing.set(message.id, next);
    next += 1;
  }

  return pairing;
}

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
