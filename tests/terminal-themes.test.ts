import { describe, expect, it } from "vitest";
import { TERMINAL_THEMES, terminalTheme } from "@/lib/terminal-themes";

const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const HEX = /^#[0-9a-f]{6}$/i;

describe("terminal themes", () => {
  it("gives every preset a full ANSI palette in hex", () => {
    for (const [name, theme] of Object.entries(TERMINAL_THEMES)) {
      expect(theme.label.length, `${name} label`).toBeGreaterThan(0);
      for (const key of ANSI_KEYS) {
        expect(theme[key], `${name}.${key}`).toMatch(HEX);
      }
      expect(theme.background, `${name}.background`).toMatch(HEX);
      expect(theme.foreground, `${name}.foreground`).toMatch(HEX);
      expect(theme.cursor, `${name}.cursor`).toMatch(HEX);
      expect(theme.selectionBackground.length, `${name}.selectionBackground`).toBeGreaterThan(0);
    }
  });

  it("returns the requested preset and falls back to dark", () => {
    expect(terminalTheme("dracula")).toBe(TERMINAL_THEMES.dracula);
    expect(terminalTheme("missing" as never)).toBe(TERMINAL_THEMES.dark);
  });
});
