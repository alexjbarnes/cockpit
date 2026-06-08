import { describe, expect, it } from "vitest";
import { appendToBuffer, MAX_BUFFER } from "@/server/terminal-buffer";

describe("appendToBuffer", () => {
  it("trims buffer past the cap and adjusts detachOffset correctly", () => {
    const state = { buffer: "x".repeat(MAX_BUFFER), detachOffset: MAX_BUFFER };
    appendToBuffer(state, "y".repeat(51200));
    expect(state.detachOffset).toBe(51200);
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
    // 10240 bytes trimmed from the front, so offset shifts by 10240
    // MAX_BUFFER + 10240 - MAX_BUFFER = 10240 trimmed
    expect(state.detachOffset).toBe(90000 - 10240);
    expect(state.buffer.length).toBe(MAX_BUFFER);
  });
});
