import { describe, expect, it } from "vitest";
import { grownRenderWindow } from "@/lib/render-window";

describe("grownRenderWindow", () => {
  const before = { total: 60, firstId: "m1" };

  it("grows by the messages appended while the reader is scrolled up", () => {
    expect(grownRenderWindow(50, before, { total: 63, firstId: "m1" }, false)).toBe(53);
  });

  it("keeps its size while following the bottom", () => {
    expect(grownRenderWindow(50, before, { total: 63, firstId: "m1" }, true)).toBe(50);
  });

  it("keeps its size when older messages are loaded at the top", () => {
    expect(grownRenderWindow(50, before, { total: 90, firstId: "h1" }, false)).toBe(50);
  });

  it("keeps its size when the list shrinks", () => {
    expect(grownRenderWindow(50, before, { total: 40, firstId: "m1" }, false)).toBe(50);
  });
});
