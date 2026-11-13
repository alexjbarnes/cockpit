import { describe, expect, it } from "vitest";
import { anchorAt, locateAnchor, makeAnchor, placeAnchors, trimSpan } from "@/lib/plan-review/anchor";

const PLAN = "Add a greeting\n\nCreate hello.txt in the root.\nWrite the word hello into it.\nAdd a test for hello.\n";

function anchorFor(text: string, words: string, from = 0) {
  const start = text.indexOf(words, from);
  const anchor = makeAnchor(text, { start, end: start + words.length });
  if (!anchor) throw new Error("no anchor");
  return anchor;
}

describe("makeAnchor", () => {
  it("keeps the words and a little either side", () => {
    const a = anchorFor(PLAN, "Create hello.txt");
    expect(a.quote).toBe("Create hello.txt");
    expect(a.prefix).toBe("Add a greeting\n\n");
    expect(a.suffix.startsWith(" in the root.")).toBe(true);
    expect(PLAN.slice(a.start, a.end)).toBe("Create hello.txt");
  });

  it("drops whitespace at the edges of a sloppy selection", () => {
    const start = PLAN.indexOf("\n\nCreate");
    const a = makeAnchor(PLAN, { start, end: start + "\n\nCreate hello.txt ".length });
    expect(a?.quote).toBe("Create hello.txt");
    expect(trimSpan("  hi  ", { start: 0, end: 6 })).toEqual({ start: 2, end: 4 });
  });

  it("refuses a selection of nothing, and clamps one that runs off the text", () => {
    expect(makeAnchor(PLAN, { start: 5, end: 5 })).toBeNull();
    expect(makeAnchor("a \n b", { start: 1, end: 3 })).toBeNull();
    expect(makeAnchor("hello", { start: -4, end: 99 })?.quote).toBe("hello");
  });
});

describe("locateAnchor", () => {
  it("finds the words where they were", () => {
    const a = anchorFor(PLAN, "Write the word hello");
    expect(locateAnchor(PLAN, a)).toEqual({ start: a.start, end: a.end });
  });

  it("tells repeated words apart by their surroundings", () => {
    const second = anchorFor(PLAN, "hello", PLAN.indexOf("word"));
    const third = anchorFor(PLAN, "hello", PLAN.indexOf("test for"));
    expect(locateAnchor(PLAN, second)).toEqual({ start: second.start, end: second.end });
    expect(locateAnchor(PLAN, third)).toEqual({ start: third.start, end: third.end });
    expect(third.start).toBeGreaterThan(second.start);
  });

  it("takes the first of several when nothing tells them apart", () => {
    expect(locateAnchor("go go go", { quote: "go", prefix: "", suffix: "" })).toEqual({ start: 0, end: 2 });
  });

  it("follows the words through a revised plan", () => {
    const a = anchorFor(PLAN, "Write the word hello into it.");
    const revised = PLAN.replace("Add a greeting\n", "Add a greeting\n\nThis plan has a new opening paragraph.\n");
    const found = locateAnchor(revised, a);
    expect(found && revised.slice(found.start, found.end)).toBe("Write the word hello into it.");
  });

  it("ignores how the text is wrapped", () => {
    const a = anchorFor(PLAN, "Create hello.txt in the root.\nWrite the word");
    const rewrapped = PLAN.replace("root.\nWrite", "root.   Write");
    const found = locateAnchor(rewrapped, a);
    expect(found && rewrapped.slice(found.start, found.end)).toBe("Create hello.txt in the root.   Write the word");
    // And the other way: a quote kept flat still finds wrapped text.
    const flat = { quote: "in the root. Write the", prefix: "", suffix: "" };
    const span = locateAnchor(PLAN, flat);
    expect(span && PLAN.slice(span.start, span.end)).toBe("in the root.\nWrite the");
  });

  it("finds words at the very start of a text that opens with whitespace", () => {
    const span = locateAnchor("\n\n  Plan title\nBody", { quote: "Plan title", prefix: "", suffix: "\nBody" });
    expect(span).toEqual({ start: 4, end: 14 });
  });

  it("gives up when the words are gone or there are none", () => {
    expect(locateAnchor(PLAN, { quote: "Delete everything", prefix: "", suffix: "" })).toBeNull();
    expect(locateAnchor(PLAN, { quote: "   ", prefix: "", suffix: "" })).toBeNull();
  });
});

describe("placeAnchors", () => {
  it("places what it can, in document order, and keeps the rest", () => {
    const late = { id: "late", ...anchorFor(PLAN, "Add a test") };
    const early = { id: "early", ...anchorFor(PLAN, "Create hello.txt") };
    const gone = { id: "gone", quote: "Removed step", prefix: "", suffix: "" };
    const note = { id: "note", quote: "", prefix: "", suffix: "" };
    const { placed, detached } = placeAnchors(PLAN, [late, gone, early, note]);
    expect(placed.map((p) => p.item.id)).toEqual(["early", "late"]);
    expect(detached.map((d) => d.id)).toEqual(["gone", "note"]);
  });

  it("orders markup that starts together by where it ends", () => {
    const long = { id: "long", ...anchorFor(PLAN, "Create hello.txt in the root.") };
    const short = { id: "short", ...anchorFor(PLAN, "Create") };
    expect(placeAnchors(PLAN, [long, short]).placed.map((p) => p.item.id)).toEqual(["short", "long"]);
  });
});

describe("anchorAt", () => {
  it("opens the innermost markup under a position", () => {
    const outer = { id: "outer", ...anchorFor(PLAN, "Create hello.txt in the root.") };
    const inner = { id: "inner", ...anchorFor(PLAN, "hello.txt") };
    const { placed } = placeAnchors(PLAN, [outer, inner]);
    expect(anchorAt(placed, PLAN.indexOf("hello.txt") + 2)?.id).toBe("inner");
    expect(anchorAt(placed, PLAN.indexOf("Create") + 1)?.id).toBe("outer");
    expect(anchorAt(placed, 0)).toBeUndefined();
    // The end of a span is the first position outside it.
    expect(anchorAt(placed, outer.end)).toBeUndefined();
  });
});

import { changedLines, changeSummary, planEditDiff } from "@/lib/plan-review/diff";

describe("plan diff", () => {
  const v1 = "# Plan\n\n1. Create the file\n2. Write hello\n3. Ship it\n";

  it("marks the lines that are new or rewritten in the newer text", () => {
    const v2 = "# Plan\n\n1. Create the file\n2. Write a greeting\n3. Ship it\n4. Add a test\n";
    expect([...changedLines(v1, v2)].sort()).toEqual([4, 6]);
    expect(changeSummary(v1, v2)).toEqual({ added: 2, removed: 1 });
  });

  it("marks the line after a removal, since nothing remains of it", () => {
    const v2 = "# Plan\n\n1. Create the file\n3. Ship it\n";
    expect([...changedLines(v1, v2)]).toEqual([4]);
    // Removed from the very end: the last line that is left takes the mark.
    expect([...changedLines(v1, "# Plan\n\n1. Create the file\n2. Write hello\n")]).toEqual([4]);
  });

  it("marks nothing when nothing changed or nothing is left", () => {
    expect(changedLines(v1, v1).size).toBe(0);
    expect(changedLines(v1, "").size).toBe(0);
    expect(changeSummary(v1, v1)).toEqual({ added: 0, removed: 0 });
  });

  it("writes a reviewer's edits as a patch without file headers", () => {
    const diff = planEditDiff(v1, v1.replace("Write hello", "Write a greeting"));
    expect(diff.startsWith("@@")).toBe(true);
    expect(diff).toContain("-2. Write hello");
    expect(diff).toContain("+2. Write a greeting");
    expect(planEditDiff(v1, v1)).toBe("");
  });
});
