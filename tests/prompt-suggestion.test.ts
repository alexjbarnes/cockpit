import { describe, expect, it } from "vitest";
import { mergePromptHistory, promptHistorySessionIds } from "@/lib/prompt-history";
import { suggestCompletion } from "@/lib/prompt-suggestion";

describe("suggestCompletion", () => {
  it("returns the most recent entry that starts with the typed text", () => {
    const history = ["commit and push", "compile the app", "commit and push please"];
    expect(suggestCompletion("co", history)).toBe("commit and push");
  });

  it("matches a lowercase prefix regardless of the history's casing", () => {
    expect(suggestCompletion("co", ["Commit and push"])).toBe("Commit and push");
  });

  it("is case-sensitive once the typed prefix has a capital", () => {
    expect(suggestCompletion("Co", ["commit and push"])).toBeNull();
    expect(suggestCompletion("Co", ["Commit and push"])).toBe("Commit and push");
  });

  it("does not offer an entry that is already complete", () => {
    expect(suggestCompletion("deploy", ["deploy"])).toBeNull();
    expect(suggestCompletion("deploy", ["deploy", "deploy staging"])).toBe("deploy staging");
  });

  it("returns null for empty or whitespace-only text", () => {
    expect(suggestCompletion("", ["deploy"])).toBeNull();
    expect(suggestCompletion("   ", ["deploy"])).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(suggestCompletion("ship", ["deploy"])).toBeNull();
  });

  it("does not match in the middle of an entry", () => {
    expect(suggestCompletion("and push", ["commit and push"])).toBeNull();
  });

  it("completes a multi-line prompt", () => {
    expect(suggestCompletion("review", ["review the diff\nand commit"])).toBe("review the diff\nand commit");
  });

  it("keeps the first match in a newest-first history", () => {
    expect(suggestCompletion("d", ["deploy now", "deploy"])).toBe("deploy now");
    expect(suggestCompletion("d", ["deploy", "deploy now"])).toBe("deploy");
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
