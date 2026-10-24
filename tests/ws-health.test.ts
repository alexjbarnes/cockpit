import { describe, expect, it } from "vitest";
import { aliveAtPongDeadline, CONNECT_TIMEOUT_MS, socketHealth } from "@/lib/ws-health";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

describe("socketHealth", () => {
  it("counts an open socket as open", () => {
    expect(socketHealth(OPEN, 0, 60_000)).toBe("open");
  });

  it("gives a socket still opening time to finish", () => {
    // The old check replaced it at the next three-second tick.
    expect(socketHealth(CONNECTING, 1_000, 4_500)).toBe("opening");
    expect(socketHealth(CONNECTING, 1_000, 1_000 + CONNECT_TIMEOUT_MS - 1)).toBe("opening");
  });

  it("gives up on a socket that takes too long to open", () => {
    expect(socketHealth(CONNECTING, 1_000, 1_000 + CONNECT_TIMEOUT_MS)).toBe("dead");
  });

  it("counts a closing or closed socket as dead", () => {
    expect(socketHealth(CLOSING, 0, 10)).toBe("dead");
    expect(socketHealth(CLOSED, 0, 10)).toBe("dead");
  });
});

describe("aliveAtPongDeadline", () => {
  it("counts anything received since the ping as proof of life", () => {
    expect(aliveAtPongDeadline(1_000, 1_000)).toBe(true);
    expect(aliveAtPongDeadline(1_000, 3_200)).toBe(true);
  });

  it("counts a socket silent since the ping as dead", () => {
    expect(aliveAtPongDeadline(1_000, 999)).toBe(false);
  });
});
