import { describe, expect, it } from "vitest";
import { isUserSetName, promptName, SESSION_NAME_MAX_CHARS, scannedSessionName, sessionName } from "@/lib/session-name";

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

describe("sessionName", () => {
  it("puts a user's name ahead of everything else", () => {
    expect(sessionName({ userTitle: "Mine", aiTitle: "Claude's", prompt: "first prompt", folder: "repo" })).toBe("Mine");
  });

  it("falls back to Claude Code's title over the first prompt", () => {
    expect(sessionName({ aiTitle: "Claude's", prompt: "first prompt", folder: "repo" })).toBe("Claude's");
  });

  it("falls back to the first prompt over the folder", () => {
    expect(sessionName({ prompt: "first prompt", folder: "repo" })).toBe("first prompt");
  });

  it("uses the folder when nothing else is known", () => {
    expect(sessionName({ folder: "repo" })).toBe("repo");
  });

  it("ignores blank candidates and trims the one it takes", () => {
    expect(sessionName({ userTitle: "   ", aiTitle: "  Claude's  ", folder: "repo" })).toBe("Claude's");
  });

  it("cuts the chosen name to the maximum length", () => {
    expect(sessionName({ aiTitle: "x".repeat(SESSION_NAME_MAX_CHARS + 10), folder: "repo" })).toHaveLength(SESSION_NAME_MAX_CHARS);
  });
});

describe("isUserSetName", () => {
  it("treats a name equal to the folder as the default it was born with", () => {
    expect(isUserSetName("repo", "repo")).toBe(false);
    expect(isUserSetName("  repo  ", "repo")).toBe(false);
    expect(isUserSetName(undefined, "repo")).toBe(false);
  });

  it("treats a different name as the user's own", () => {
    expect(isUserSetName("Mine", "repo")).toBe(true);
  });
});

describe("scannedSessionName", () => {
  it("puts a user's name ahead of the scan and the memory entry", () => {
    expect(scannedSessionName("Stored title", "repo", "Mine")).toBe("Mine");
  });

  it("keeps the scanned title over an in-memory folder name", () => {
    expect(scannedSessionName("Stored title", "repo")).toBe("Stored title");
  });

  it("falls back to the memory name when the scan found no title", () => {
    expect(scannedSessionName("Untitled session", "repo")).toBe("repo");
  });
});
