import { describe, expect, it } from "vitest";
import { pairQuestionBlocks, splitAtQuestion } from "@/lib/split-question-blocks";
import type { ContentBlock, ToolUse } from "@/types";

function text(t: string): ContentBlock {
  return { type: "text", text: t };
}

function thinking(t: string): ContentBlock {
  return { type: "thinking", text: t };
}

function toolUse(name: string, opts?: Partial<ToolUse>): ContentBlock {
  return {
    type: "tool_use",
    toolUse: {
      id: `tool-${name}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      input: "",
      output: "",
      status: "done",
      ...opts,
    },
  };
}

describe("splitAtQuestion", () => {
  it("returns all blocks as before when no AskUserQuestion exists", () => {
    const blocks = [thinking("hmm"), text("hello"), toolUse("Read")];
    const result = splitAtQuestion(blocks);

    expect(result.questionBlock).toBeNull();
    expect(result.before).toEqual(blocks);
    expect(result.after).toEqual([]);
  });

  it("splits at AskUserQuestion with thinking before and text after", () => {
    const blocks = [
      thinking("let me ask"),
      toolUse("AskUserQuestion", { input: '{"questions":[]}' }),
      text("You picked option A"),
      toolUse("Read"),
    ];
    const result = splitAtQuestion(blocks);

    expect(result.before).toHaveLength(1);
    expect(result.before[0].type).toBe("thinking");

    expect(result.questionBlock).not.toBeNull();
    expect(result.questionBlock!.toolUse.name).toBe("AskUserQuestion");

    expect(result.after).toHaveLength(2);
    expect(result.after[0]).toEqual(text("You picked option A"));
    expect(result.after[1].type).toBe("tool_use");
  });

  it("splits when AskUserQuestion is the first block", () => {
    const blocks = [toolUse("AskUserQuestion"), text("response")];
    const result = splitAtQuestion(blocks);

    expect(result.before).toHaveLength(0);
    expect(result.questionBlock).not.toBeNull();
    expect(result.after).toHaveLength(1);
    expect(result.after[0]).toEqual(text("response"));
  });

  it("splits when AskUserQuestion is the last block", () => {
    const blocks = [thinking("thinking"), text("some text"), toolUse("AskUserQuestion")];
    const result = splitAtQuestion(blocks);

    expect(result.before).toHaveLength(2);
    expect(result.questionBlock).not.toBeNull();
    expect(result.after).toHaveLength(0);
  });

  it("splits at the first AskUserQuestion and filters duplicates from after", () => {
    const blocks = [
      thinking("thinking"),
      toolUse("AskUserQuestion", { id: "q1" }),
      text("response"),
      toolUse("AskUserQuestion", { id: "q2" }),
      toolUse("Edit"),
    ];
    const result = splitAtQuestion(blocks);

    expect(result.before).toHaveLength(1);
    expect(result.questionBlock!.toolUse.id).toBe("q1");
    // q2 should be filtered out, only text and Edit remain
    expect(result.after).toHaveLength(2);
    expect(result.after[0]).toEqual(text("response"));
    expect(result.after[1].type).toBe("tool_use");
    if (result.after[1].type === "tool_use") {
      expect(result.after[1].toolUse.name).toBe("Edit");
    }
  });

  it("preserves question block tool output for determining static vs interactive", () => {
    const blocks = [thinking("thinking"), toolUse("AskUserQuestion", { output: '{"answers":{}}' }), text("You chose X")];
    const result = splitAtQuestion(blocks);

    expect(result.questionBlock!.toolUse.output).toBe('{"answers":{}}');
  });

  it("handles empty blocks array", () => {
    const result = splitAtQuestion([]);

    expect(result.before).toEqual([]);
    expect(result.questionBlock).toBeNull();
    expect(result.after).toEqual([]);
  });

  it("handles AskUserQuestion as the only block", () => {
    const blocks = [toolUse("AskUserQuestion")];
    const result = splitAtQuestion(blocks);

    expect(result.before).toHaveLength(0);
    expect(result.questionBlock).not.toBeNull();
    expect(result.after).toHaveLength(0);
  });

  it("handles complex streaming scenario: thinking, question, then response with multiple tools", () => {
    const blocks = [
      thinking("I should ask about the approach"),
      toolUse("AskUserQuestion", {
        id: "ask-1",
        input: '{"questions":[{"question":"Which approach?","options":[{"label":"A"},{"label":"B"}]}]}',
        output: '"Which approach?"="A"',
      }),
      text("You picked A. Let me implement that."),
      toolUse("Read", { id: "read-1" }),
      toolUse("Edit", { id: "edit-1" }),
      text("Done. I've updated the file."),
    ];
    const result = splitAtQuestion(blocks);

    // Before: just thinking
    expect(result.before).toHaveLength(1);
    expect(result.before[0].type).toBe("thinking");

    // Question block preserved with output
    expect(result.questionBlock!.toolUse.id).toBe("ask-1");
    expect(result.questionBlock!.toolUse.output).toBeTruthy();

    // After: text, Read, Edit, text (4 blocks, no AskUserQuestion)
    expect(result.after).toHaveLength(4);
    expect(result.after.map((b) => b.type)).toEqual(["text", "tool_use", "tool_use", "text"]);
  });
});

describe("pairQuestionBlocks", () => {
  function assistant(id: string, blocks: ContentBlock[]) {
    return { id, role: "assistant", blocks };
  }

  const question = (opts?: Partial<ToolUse>) => toolUse("AskUserQuestion", { output: "", ...opts });

  it("gives each unanswered block its own request slot, in message order", () => {
    const pairing = pairQuestionBlocks([
      assistant("m1", [text("first"), question()]),
      { id: "u1", role: "user", blocks: [] },
      assistant("m2", [question()]),
    ]);

    expect([...pairing.entries()]).toEqual([
      ["m1", 0],
      ["m2", 1],
    ]);
  });

  it("leaves a duplicate of the same turn without a slot of its own", () => {
    // The reported duplicate: one request rendered as two identical cards, each
    // with its own selection. The second copy must pair with nothing, so with a
    // single pending request only one card can render.
    const pairing = pairQuestionBlocks([assistant("m1", [question()]), assistant("m1", [question()])]);

    expect(pairing.size).toBe(1);
    expect(pairing.get("m1")).toBe(0);
  });

  it("leaves a copy of the same question under a different message id without a slot", () => {
    // The live message_done and the transcript re-parse id one turn differently,
    // so the client can hold two copies of the same assistant message. The tool
    // use id is stable across both, so the second copy must pair with nothing.
    const pairing = pairQuestionBlocks([
      assistant("live-id", [question({ id: "toolu_01" })]),
      assistant("file-id", [question({ id: "toolu_01" })]),
    ]);

    expect(pairing.size).toBe(1);
    expect(pairing.get("live-id")).toBe(0);
    expect(pairing.has("file-id")).toBe(false);
  });

  it("still slots two genuinely different questions from the same turn", () => {
    const pairing = pairQuestionBlocks([assistant("m1", [question({ id: "toolu_01" }), question({ id: "toolu_02" })])]);

    // splitAtQuestion only takes the first block of a message, so one slot.
    expect(pairing.size).toBe(1);
    expect(pairing.get("m1")).toBe(0);
  });

  it("skips answered blocks, so a follow-up still reaches slot 0", () => {
    const pairing = pairQuestionBlocks([assistant("m1", [question({ output: "chose A" })]), assistant("m2", [question()])]);

    expect(pairing.has("m1")).toBe(false);
    expect(pairing.get("m2")).toBe(0);
  });

  it("ignores user messages and messages without a question", () => {
    const pairing = pairQuestionBlocks([
      { id: "u1", role: "user", blocks: [question()] },
      assistant("m1", [text("no question here")]),
      assistant("m2", []),
    ]);

    expect(pairing.size).toBe(0);
  });

  it("renders one card for the reported duplicate: twin messages plus a request forwarded twice", () => {
    // The reported failure (5034a1f): a question showed as two identical cards
    // the moment it raised. Two mechanisms compounded: the same assistant turn
    // arrived under two message ids (live message_done vs transcript re-parse),
    // and the same pending request was forwarded twice. Simulate the client
    // state after both — twin messages, and a pending list the request dedupe
    // (pushPendingQuestion) kept at one entry — then apply the render decision
    // from chat-view: a card renders for each message whose pairing slot has an
    // unanswered request.
    const messages = [assistant("live-id", [question({ id: "toolu_01" })]), assistant("file-id", [question({ id: "toolu_01" })])];
    const unanswered = [{ requestId: "r1", questions: "q" }];
    const pairing = pairQuestionBlocks(messages);

    const cards = messages.filter((m) => {
      const slot = pairing.get(m.id);
      return slot !== undefined && unanswered[slot] !== undefined;
    });

    expect(cards.map((m) => m.id)).toEqual(["live-id"]);
    expect(pairing.size).toBe(1);
  });
});
