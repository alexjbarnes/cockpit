import { describe, expect, it, vi } from "vitest";

const writes: string[] = [];
const mockPty = {
  write: vi.fn((data: string) => writes.push(data)),
  onData: vi.fn(),
  onExit: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  pid: 999,
};

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => mockPty),
}));

import { PtySession } from "@/server/pty-session";

describe("PtySession.sendText", () => {
  it("sends Ctrl+U before text to clear stale input", async () => {
    const session = new PtySession({
      cwd: "/tmp",
      settingsPath: "/tmp/fake-settings.json",
    });

    // Inject the mock PTY directly so we skip start() lifecycle
    (session as unknown as { pty: typeof mockPty }).pty = mockPty;

    writes.length = 0;
    await session.sendText("hello");

    expect(writes[0]).toBe("\x15");
    expect(writes[1]).toBe("hello");
    expect(writes[2]).toBe("\r");
    expect(writes).toHaveLength(3);
  });
});
