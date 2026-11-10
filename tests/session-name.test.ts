import { describe, expect, it } from "vitest";
import { promptName, SESSION_NAME_MAX_CHARS } from "@/lib/session-name";

const user = (content: string, isCompactSummary?: boolean) => ({ role: "user" as const, content, isCompactSummary });

describe("promptName", () => {
  it("takes the first prompt the user typed", () => {
    expect(promptName([user("Url submit"), user("And then something else")])).toBe("Url submit");
  });

  it("skips a context compaction summary and uses the first real prompt after it", () => {
    expect(
      promptName([user("This session is being continued from a previous conversation that ran out of context.", true), user("Url submit")]),
    ).toBe("Url submit");
  });

  it("returns null when the only user message is a compaction summary", () => {
    expect(promptName([user("This session is being continued from a previous conversation.", true)])).toBeNull();
  });

  it("skips system-generated messages that start with [ or <", () => {
    expect(promptName([user("[Request interrupted by user]"), user("<command-name>/clear</command-name>"), user("Real prompt")])).toBe(
      "Real prompt",
    );
  });

  it("cuts the name to its maximum length", () => {
    const name = promptName([user("x".repeat(SESSION_NAME_MAX_CHARS + 40))]);
    expect(name).toHaveLength(SESSION_NAME_MAX_CHARS);
  });
});
