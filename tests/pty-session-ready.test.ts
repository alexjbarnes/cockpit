// Startup-readiness tests. The REPL paints in bursts and cockpit used to sleep
// a flat 2s after the first bytes; readiness now waits for the paint to go
// quiet, so these cases pin both the "don't return mid-paint" and the "don't
// wait longer than needed" halves of that trade.
import { describe, expect, it, vi } from "vitest";

type DataHandler = (chunk: string) => void;
type ExitHandler = (info: { exitCode: number; signal?: number }) => void;

let dataHandler: DataHandler | null = null;
let exitHandler: ExitHandler | null = null;

const mockPty = {
  write: vi.fn(),
  onData: vi.fn((cb: DataHandler) => {
    dataHandler = cb;
  }),
  onExit: vi.fn((cb: ExitHandler) => {
    exitHandler = cb;
  }),
  resize: vi.fn(),
  kill: vi.fn(),
  pid: 4242,
};

vi.mock("node-pty", () => ({ spawn: vi.fn(() => mockPty) }));
vi.mock("node:fs", () => ({
  existsSync: () => true,
  realpathSync: (p: string) => p,
  statSync: () => ({ mode: 0o755, size: 100 }),
}));

import { PtySession } from "@/server/pty-session";

function newSession(): PtySession {
  dataHandler = null;
  exitHandler = null;
  return new PtySession({ cwd: "/tmp", settingsPath: "/tmp/settings.json", bin: "/bin/claude" });
}

/** Terminal-setup escapes: enough bytes to clear the readiness threshold. */
const FIRST_BURST = "\x1b[?25l\x1b[?2004h".padEnd(140, "-");

function emit(chunk: string): void {
  dataHandler?.(chunk);
}

describe("PtySession startup readiness", () => {
  it("waits for the paint to go quiet before reporting ready", async () => {
    vi.useFakeTimers();
    try {
      const session = newSession();
      const started = session.start();
      // Let start() reach its first poll so the data handler is registered.
      await vi.advanceTimersByTimeAsync(0);

      emit(FIRST_BURST);
      let settled = false;
      void started.then(() => {
        settled = true;
      });

      // Still painting: more output keeps arriving inside the quiet window.
      await vi.advanceTimersByTimeAsync(200);
      emit("input box");
      await vi.advanceTimersByTimeAsync(200);
      emit("footer");
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).toBe(false);

      // Output stops: the quiet gap elapses and startup completes.
      await vi.advanceTimersByTimeAsync(400);
      await started;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns well before the old flat settle when the REPL paints in one burst", async () => {
    vi.useFakeTimers();
    try {
      const session = newSession();
      const started = session.start();
      await vi.advanceTimersByTimeAsync(0);
      emit(FIRST_BURST);

      let settled = false;
      void started.then(() => {
        settled = true;
      });

      // The flat sleep this replaced was 2000ms; a quiet REPL is ready far sooner.
      await vi.advanceTimersByTimeAsync(600);
      expect(settled).toBe(true);
      await started;
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up waiting for quiet at the cap when output never stops", async () => {
    vi.useFakeTimers();
    try {
      const session = newSession();
      const started = session.start();
      await vi.advanceTimersByTimeAsync(0);
      emit(FIRST_BURST);

      let settled = false;
      void started.then(() => {
        settled = true;
      });

      // A REPL that chatters forever must not stall the spawn: keep it noisy
      // past the cap and startup still completes.
      for (let i = 0; i < 30; i++) {
        emit("noise");
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(settled).toBe(true);
      await started;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails when the CLI exits during startup", async () => {
    vi.useFakeTimers();
    try {
      const session = newSession();
      const started = session.start();
      const assertion = expect(started).rejects.toThrow(/exited during startup/);
      await vi.advanceTimersByTimeAsync(0);

      emit(FIRST_BURST);
      exitHandler?.({ exitCode: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

// The workspace-trust dialog decides whether the CLI runs at all, and cockpit
// cannot answer it: Enter, arrow keys and a pre-set hasTrustDialogAccepted were
// each measured against CLI 2.1.248 and none dismiss it. Before this, start()
// went on to type the whole prompt into the dialog and the CLI exited 1, which
// a scheduled job reported as "went idle without producing any assistant
// message" — no transcript, no mention of trust. Screen is as recorded,
// including the intra-row spaces the TUI's per-character painting eats.
describe("PtySession workspace trust", () => {
  const TRUST_DIALOG =
    "\x1b[?25l────────────\nAccessingworkspace:\n/tmp\n\nQuicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?\n\n❯No,exit\nYes,Itrustthisfolder\n\nEntertoconfirm·Esctocancel\n";

  it("fails with a typed error naming the directory when the dialog will not clear", async () => {
    vi.useFakeTimers();
    try {
      const session = newSession();
      const started = session.start();
      await vi.advanceTimersByTimeAsync(0);
      emit(TRUST_DIALOG);
      // The Enter goes out; 2s later the dialog is still on screen.
      await vi.advanceTimersByTimeAsync(2500);
      emit(TRUST_DIALOG);
      await vi.advanceTimersByTimeAsync(100);

      await expect(started).rejects.toMatchObject({ name: "UntrustedWorkspaceError", cwd: "/tmp" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries on when the Enter does clear it, as on CLI versions where Yes is the default", async () => {
    vi.useFakeTimers();
    try {
      const session = newSession();
      const started = session.start();
      await vi.advanceTimersByTimeAsync(0);
      emit(TRUST_DIALOG);
      // Enough for the loop to spot it and send Enter, but inside the 2s it
      // then waits before re-checking the screen.
      await vi.advanceTimersByTimeAsync(300);
      // Dialog gone, REPL painting in its place.
      (session as unknown as { buffer: string }).buffer = "";
      emit(FIRST_BURST);
      await vi.advanceTimersByTimeAsync(5000);

      await expect(started).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
