import { describe, expect, it } from "vitest";
import { appendToBuffer, MAX_BUFFER } from "@/server/terminal-buffer";

describe("appendToBuffer", () => {
  it("trims buffer past the cap and adjusts detachOffset correctly", () => {
    const state = { buffer: "x".repeat(MAX_BUFFER), detachOffset: MAX_BUFFER };
    appendToBuffer(state, "y".repeat(51200));
    expect(state.detachOffset).toBe(MAX_BUFFER - 51200);
    expect(state.buffer.slice(state.detachOffset)).toBe("y".repeat(51200));
  });

  it("does not trim output that stays under the cap", () => {
    const state = { buffer: "hello", detachOffset: 0 };
    appendToBuffer(state, " world");
    expect(state.buffer).toBe("hello world");
    expect(state.detachOffset).toBe(0);
  });

  it("handles a single append larger than the cap with detachOffset 0", () => {
    const state = { buffer: "", detachOffset: 0 };
    appendToBuffer(state, "z".repeat(MAX_BUFFER + 100));
    expect(state.buffer.length).toBe(MAX_BUFFER);
    expect(state.detachOffset).toBe(0);
  });

  it("maintains detachOffset for partial buffer trimming", () => {
    const state = { buffer: "a".repeat(MAX_BUFFER), detachOffset: 90000 };
    appendToBuffer(state, "b".repeat(10240));
    expect(state.detachOffset).toBe(90000 - 10240);
    expect(state.buffer.length).toBe(MAX_BUFFER);
  });

  it("starts a trimmed replay on a line boundary", () => {
    const state = { buffer: "old\n", detachOffset: 0 };
    appendToBuffer(state, "0123456789\nrest\nmore", 20);
    // The raw cut would land inside the first line; the next newline is at the
    // start of the cut region, so the buffer begins there.
    expect(state.buffer).toBe("0123456789\nrest\nmore");
  });

  it("keeps the last bytes when a long line has no boundary", () => {
    const state = { buffer: "a".repeat(10), detachOffset: 0 };
    appendToBuffer(state, "b".repeat(20), 15);
    expect(state.buffer).toBe("b".repeat(15));
  });

  it("does not split a surrogate pair when trimming", () => {
    const state = { buffer: "x".repeat(10) + "😀" + "y".repeat(10), detachOffset: 0 };
    appendToBuffer(state, "", 11);
    expect(state.buffer).toBe("y".repeat(10));
  });

  it("clamps detachOffset when the trim passes it", () => {
    const state = { buffer: "a".repeat(20), detachOffset: 5 };
    appendToBuffer(state, "b".repeat(20), 15);
    expect(state.detachOffset).toBe(0);
  });
});
