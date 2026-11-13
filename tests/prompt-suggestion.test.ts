import { describe, expect, it } from "vitest";
import { mergePromptHistory, promptHistorySessionIds } from "@/lib/prompt-history";
import { suggestCompletion } from "@/lib/prompt-suggestion";

describe("suggestCompletion", () => {
  it("completes the most recent prompt that starts with the typed text", () => {
    const history = ["commit and tag", "compile the app", "commit and push"];
    expect(suggestCompletion("co", history)).toEqual({ prompt: "commit and tag", prefix: true });
  });

  it("matches a lowercase prefix regardless of the history's casing", () => {
    expect(suggestCompletion("co", ["Commit and push"])).toEqual({ prompt: "Commit and push", prefix: true });
  });

  it("is case-sensitive once the typed text has a capital", () => {
    expect(suggestCompletion("Co", ["commit and push"])).toBeNull();
    expect(suggestCompletion("Co", ["Commit and push"])).toEqual({ prompt: "Commit and push", prefix: true });
  });

  it("finds a repeatable command from a later word", () => {
    expect(suggestCompletion("push", ["commit and push"])).toEqual({ prompt: "commit and push", prefix: false });
  });

  it("matches a start that skips a filler word", () => {
    expect(suggestCompletion("commit push", ["commit and push"])).toEqual({ prompt: "commit and push", prefix: false });
  });

  it("tolerates one typo in the start of a command", () => {
    expect(suggestCompletion("comit", ["commit and push"])).toEqual({ prompt: "commit and push", prefix: false });
  });

  it("prefers a prefix over a fuzzy match", () => {
    expect(suggestCompletion("push", ["push the branch", "commit and push"])).toEqual({ prompt: "push the branch", prefix: true });
  });

  it("does not offer long prose, however well it starts", () => {
    const prose = "Fix the terminal history bug where the replay buffer trims the scrollback after a long progress line";
    expect(suggestCompletion("Fix the terminal", [prose])).toBeNull();
  });

  it("does not offer a question or a multi-sentence prompt", () => {
    expect(suggestCompletion("can", ["can you look at this?"])).toBeNull();
    expect(suggestCompletion("commit", ["commit and push. then deploy."])).toBeNull();
  });

  it("does not offer an entry that is already complete", () => {
    expect(suggestCompletion("deploy", ["deploy"])).toBeNull();
    expect(suggestCompletion("deploy", ["deploy", "deploy staging"])).toEqual({ prompt: "deploy staging", prefix: true });
  });

  it("needs at least two characters", () => {
    expect(suggestCompletion("", ["deploy"])).toBeNull();
    expect(suggestCompletion("   ", ["deploy"])).toBeNull();
    expect(suggestCompletion("d", ["deploy"])).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(suggestCompletion("ship", ["deploy"])).toBeNull();
  });

  it("does not match an arbitrary substring", () => {
    expect(suggestCompletion("mmi", ["commit and push"])).toBeNull();
  });

  it("completes a multi-line prompt", () => {
    expect(suggestCompletion("review", ["review the diff\nand commit"])).toEqual({
      prompt: "review the diff\nand commit",
      prefix: true,
    });
  });

  it("keeps the newest match among equals", () => {
    expect(suggestCompletion("de", ["deploy now", "deploy later"])).toEqual({ prompt: "deploy now", prefix: true });
    expect(suggestCompletion("de", ["deploy later", "deploy now"])).toEqual({ prompt: "deploy later", prefix: true });
  });
});

describe("promptHistorySessionIds", () => {
  it("visits the running session first, then previous ones newest-first", () => {
    expect(promptHistorySessionIds("current", ["oldest", "middle"])).toEqual(["current", "middle", "oldest"]);
  });

  it("handles a session with no predecessors", () => {
    expect(promptHistorySessionIds("only", [])).toEqual(["only"]);
  });
});

describe("mergePromptHistory", () => {
  it("keeps every segment's order", () => {
    expect(mergePromptHistory([["c2", "c1"], ["b1"], ["a2", "a1"]])).toEqual(["c2", "c1", "b1", "a2", "a1"]);
  });

  it("keeps the newest occurrence of a repeated prompt", () => {
    expect(
      mergePromptHistory([
        ["c1", "shared"],
        ["b1", "shared"],
      ]),
    ).toEqual(["c1", "shared", "b1"]);
  });

  it("handles empty segments", () => {
    expect(mergePromptHistory([[], ["a"], []])).toEqual(["a"]);
  });
});
