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

import { spawn } from "node-pty";
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

  it("frames multi-line text as a bracketed paste so embedded newlines aren't submitted", async () => {
    const session = new PtySession({
      cwd: "/tmp",
      settingsPath: "/tmp/fake-settings.json",
    });
    (session as unknown as { pty: typeof mockPty }).pty = mockPty;

    writes.length = 0;
    // A blank line splitting two paragraphs — the shape that was mis-submitted as
    // "/compact" when written raw (see pty-session.ts sendText / multiline-send.spec.ts).
    await session.sendText("first line\n\nsecond line");

    expect(writes[0]).toBe("\x15");
    expect(writes[1]).toBe("\x1b[200~first line\n\nsecond line\x1b[201~");
    expect(writes[2]).toBe("\r");
    expect(writes).toHaveLength(3);
  });
});

describe("PtySession.start spawn env", () => {
  it("suppresses the CLI resume picker via threshold overrides", async () => {
    const session = new PtySession({
      cwd: "/tmp",
      settingsPath: "/tmp/fake-settings.json",
    });

    const startPromise = session.start();
    // spawn and the onExit registration run synchronously inside start(); flag
    // the process as exited so the trust-dialog/REPL-ready waits bail out fast.
    const onExit = mockPty.onExit.mock.calls.at(-1)?.[0] as (info: { exitCode: number }) => void;
    onExit({ exitCode: 0 });
    await expect(startPromise).rejects.toThrow("exited during startup");

    const spawnOpts = vi.mocked(spawn).mock.calls.at(-1)?.[2] as { env: Record<string, string> };
    // Out-of-reach thresholds keep the "Resume from summary" picker from ever
    // rendering — its default option runs /compact, eating the first message
    // typed into it (see pty-session.ts start()).
    expect(spawnOpts.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES).toBe("999999999");
    expect(spawnOpts.env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD).toBe("999999999");
  });
});
