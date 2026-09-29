import { describe, expect, it } from "vitest";
import { unwrapPastedContent } from "@/lib/pasted-content";

// The shape CLI 2.1.281 writes for a message typed as one bracketed paste:
// two newlines, the opener, the body, a newline, the closer, a newline.
function wrapped(id: string, body: string): string {
  return `\n\n<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">\n`;
}

describe("unwrapPastedContent", () => {
  it("returns text without a wrapper untouched", () => {
    expect(unwrapPastedContent("just a message")).toBe("just a message");
    expect(unwrapPastedContent("")).toBe("");
  });

  it("recovers a multi-line message sent as one paste, exactly as typed", () => {
    const typed = "Why is this container restarting?\n$ docker ps\nCONTAINER ID   IMAGE\nabc123   web:1";
    expect(unwrapPastedContent(wrapped("6dca", typed))).toBe(typed);
  });

  // The live report: a user pasted an example of the bug, which carried a tag
  // of its own. The CLI escaped it inside the outer paste as <\ and <\/.
  it("restores a tag the CLI escaped inside the paste", () => {
    const typed = 'Seeing this:\n<pasted_content id="cb0d">\nsome output\n</pasted_content id="cb0d">';
    const stored = wrapped("6dca", 'Seeing this:\n<\\pasted_content id="cb0d">\nsome output\n<\\/pasted_content id="cb0d">');
    expect(unwrapPastedContent(stored)).toBe(typed);
  });

  it("leaves a backslash that is not escaping the tag name alone", () => {
    const body = "a path like C:\\<temp and a <\\other_tag>";
    expect(unwrapPastedContent(wrapped("0001", body))).toBe(body);
  });

  it("treats an opener with an invalid id as ordinary text", () => {
    for (const id of ["zzzz", "ABCD", "abc", "abcde"]) {
      const text = `<pasted_content id="${id}">\nbody\n</pasted_content id="${id}">`;
      expect(unwrapPastedContent(text)).toBe(text);
    }
  });

  it("requires the newline straight after the opener", () => {
    const text = '<pasted_content id="abcd"> body\n</pasted_content id="abcd">';
    expect(unwrapPastedContent(text)).toBe(text);
  });

  it("skips a malformed opener and still unwraps a valid block after it", () => {
    const text = `<pasted_content id="nope">${wrapped("ab12", "real body")}`;
    expect(unwrapPastedContent(text)).toBe('<pasted_content id="nope">real body');
  });

  it("leaves an unclosed block, and everything after it, as it stands", () => {
    const text = '\n\n<pasted_content id="abcd">\nnever closed';
    expect(unwrapPastedContent(text)).toBe(text);
  });

  it("does not close a block on another block's closer", () => {
    const text = '\n\n<pasted_content id="aaaa">\nbody\n</pasted_content id="bbbb">\n';
    expect(unwrapPastedContent(text)).toBe(text);
  });

  it("unwraps an empty paste", () => {
    expect(unwrapPastedContent('<pasted_content id="abcd">\n</pasted_content id="abcd">\n')).toBe("");
  });

  // The CLI inserts the newlines around a block when it writes it, and its own
  // unwrapper takes back up to two on each side; more than that were typed.
  it("swallows up to two newlines each side of a block, and no more", () => {
    const stored = `before\n\n\n<pasted_content id="abcd">\nX\n</pasted_content id="abcd">\n\n\nafter`;
    expect(unwrapPastedContent(stored)).toBe("before\nX\nafter");
  });

  it("unwraps several blocks with text between them", () => {
    const stored = `intro\n\n<pasted_content id="0a0a">\none\n</pasted_content id="0a0a">\nmiddle\n\n<pasted_content id="0b0b">\ntwo\n</pasted_content id="0b0b">\n`;
    expect(unwrapPastedContent(stored)).toBe("introonemiddletwo");
  });

  // Three newlines between two blocks: the first takes two after its closer,
  // the second takes the one left before its opener, and none is taken twice.
  it("shares the separators between adjacent blocks without double-counting", () => {
    const stored = `<pasted_content id="0a0a">\none\n</pasted_content id="0a0a">\n\n\n<pasted_content id="0b0b">\ntwo\n</pasted_content id="0b0b">`;
    expect(unwrapPastedContent(stored)).toBe("onetwo");
  });
});
