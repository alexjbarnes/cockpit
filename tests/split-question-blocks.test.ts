import { describe, it, expect } from "vitest";
import { splitAtQuestion } from "@/lib/split-question-blocks";
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
    const blocks = [
      toolUse("AskUserQuestion"),
      text("response"),
    ];
    const result = splitAtQuestion(blocks);

    expect(result.before).toHaveLength(0);
    expect(result.questionBlock).not.toBeNull();
    expect(result.after).toHaveLength(1);
    expect(result.after[0]).toEqual(text("response"));
  });

  it("splits when AskUserQuestion is the last block", () => {
    const blocks = [
      thinking("thinking"),
      text("some text"),
      toolUse("AskUserQuestion"),
    ];
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
    const blocks = [
      thinking("thinking"),
      toolUse("AskUserQuestion", { output: '{"answers":{}}' }),
      text("You chose X"),
    ];
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
    expect(result.after.map((b) => b.type)).toEqual([
      "text", "tool_use", "tool_use", "text",
    ]);
  });
});
