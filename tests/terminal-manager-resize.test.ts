import { describe, expect, it, vi } from "vitest";
import { TerminalManager } from "@/server/terminal-manager";

describe("TerminalManager.resizeTerminal", () => {
  it("keeps the output when the width changes", () => {
    const manager = new TerminalManager();
    const pty = { resize: vi.fn() };
    const term = {
      id: "term-1",
      pty,
      cwd: "/",
      cols: 80,
      rows: 24,
      buffer: "previous output",
      detachOffset: 4,
      client: null,
    };
    (manager as unknown as { terminals: Map<string, typeof term> }).terminals.set("term-1", term);

    expect(manager.resizeTerminal("term-1", 100, 24)).toBe(true);

    expect(pty.resize).toHaveBeenCalledWith(100, 24);
    // A width change reflows on replay; it must not discard the session's
    // output, which is what the next client attaches to.
    expect(term.buffer).toBe("previous output");
    expect(term.detachOffset).toBe(4);
  });
});
