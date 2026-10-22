// The chat's own scroll anchoring for messages added above the reader.
import { describe, expect, it } from "vitest";
import { anchorCorrection, anchorFromItems, type MeasuredItem } from "@/lib/reading-anchor";

describe("anchorFromItems", () => {
  const items = [
    { id: "a", top: -300, bottom: -100 },
    { id: "b", top: -100, bottom: 40 },
    { id: "c", top: 40, bottom: 200 },
  ];
  const from = (list: MeasuredItem[], viewTop: number) => anchorFromItems(list.length, (i) => list[i], viewTop);

  it("is the first message still showing at the top of the view", () => {
    expect(from(items, 0)).toEqual({ id: "b", offset: -100 });
    expect(from(items, -500)).toEqual({ id: "a", offset: 200 });
  });

  it("measures from the top of the scroller, wherever that is on the page", () => {
    expect(from(items, 30)).toEqual({ id: "b", offset: -130 });
  });

  it("skips an item with no id, and is nothing when nothing is in view", () => {
    expect(from([{ id: "", top: 0, bottom: 50 }, ...items.slice(2)], 0)).toEqual({ id: "c", offset: 40 });
    expect(from(items, 500)).toBeNull();
    expect(from([], 0)).toBeNull();
  });

  it("measures a handful of a long chat's messages, not every one above the reader", () => {
    const long = Array.from({ length: 1000 }, (_, i) => ({ id: `m${i}`, top: i * 100, bottom: (i + 1) * 100 }));
    let measured = 0;
    const anchor = anchorFromItems(
      long.length,
      (i) => {
        measured++;
        return long[i];
      },
      74_050,
    );
    expect(anchor).toEqual({ id: "m740", offset: -50 });
    expect(measured).toBeLessThanOrEqual(12);
  });
});

describe("anchorCorrection", () => {
  it("scrolls by however far an insertion pushed the anchor", () => {
    // 2000px of older messages landed above, and nothing compensated.
    expect(anchorCorrection({ id: "b", offset: -20 }, 1980)).toBe(2000);
  });

  it("does nothing when the browser already kept it in place", () => {
    expect(anchorCorrection({ id: "b", offset: -20 }, -20)).toBe(0);
    expect(anchorCorrection({ id: "b", offset: -20 }, -19.5)).toBe(0);
  });

  it("scrolls back up too, if the anchor ended up higher", () => {
    expect(anchorCorrection({ id: "b", offset: 100 }, 40)).toBe(-60);
  });
});
