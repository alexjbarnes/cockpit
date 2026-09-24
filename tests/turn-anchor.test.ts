import { describe, expect, it } from "vitest";
import { turnStartAnchor, turnStartFromElapsed } from "@/lib/turn-anchor";

const NOW = 1_800_000_000_000;

describe("turnStartAnchor", () => {
  // The reported case: a long turn, the page left and reopened. The user's
  // message is outside what the page holds, so only the server knows the start.
  it("trusts the server's start over anything the page holds", () => {
    expect(turnStartAnchor(NOW - 600_000, null, NOW)).toBe(NOW - 600_000);
    expect(turnStartAnchor(NOW - 600_000, NOW - 5_000, NOW)).toBe(NOW - 600_000);
  });

  it("never anchors in the future, whatever the server reported", () => {
    expect(turnStartAnchor(NOW + 1_000, null, NOW)).toBe(NOW);
  });

  it("falls back to the newest user message the page holds", () => {
    expect(turnStartAnchor(null, NOW - 30_000, NOW)).toBe(NOW - 30_000);
  });

  // A transcript copy stamped by a server whose clock runs ahead of this device.
  it("treats a user message stamped in the future as unusable", () => {
    expect(turnStartAnchor(null, NOW + 30_000, NOW)).toBe(NOW);
  });

  it("counts from now when there is nothing to anchor to", () => {
    expect(turnStartAnchor(null, null, NOW)).toBe(NOW);
  });
});

describe("turnStartFromElapsed", () => {
  it("places the start that long before now, on this device's clock", () => {
    expect(turnStartFromElapsed(125_000, NOW)).toBe(NOW - 125_000);
  });

  it("treats a negative elapsed as a turn that has only just started", () => {
    expect(turnStartFromElapsed(-50, NOW)).toBe(NOW);
  });
});
