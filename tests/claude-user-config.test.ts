// The CLI's user config (~/.claude.json) has several writers: the CLI itself,
// cockpit's trust path and cockpit's MCP-server tool. On this project's dev
// container the file is its own mount, so rename onto it fails EBUSY and the
// atomic swap is unavailable exactly where the writers collide. What the
// fallback must not do is leave a file a reader can catch half-written, because
// one unparseable read makes the CLI quarantine the file and continue from
// defaults, which is the wipe that loses every MCP server.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { renameFails } = vi.hoisted(() => ({ renameFails: { value: false } }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (renameFails.value) throw Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" });
      return actual.renameSync(from, to);
    },
  };
});

import {
  readClaudeUserConfig,
  resolveClaudeUserConfigPath,
  updateClaudeUserConfig,
  writeClaudeUserConfig,
} from "@/server/claude-user-config";

let root: string;
let claudeHome: string;
let prevClaude: string | undefined;

const configFile = () => path.join(claudeHome, ".claude.json");

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cockpit-config-"));
  claudeHome = path.join(root, "home");
  mkdirSync(claudeHome, { recursive: true });
  prevClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  renameFails.value = false;
});

afterEach(() => {
  if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaude;
  renameFails.value = false;
  rmSync(root, { recursive: true, force: true });
});

describe("writing the CLI user config", () => {
  it("swaps the file in whole while rename is available", () => {
    writeFileSync(configFile(), JSON.stringify({ projects: { "/a": { lastCost: 1 } } }));
    const before = statSync(configFile()).ino;

    expect(
      updateClaudeUserConfig((data) => {
        data.marker = "new";
        return true;
      }),
    ).toBe(true);

    expect(statSync(configFile()).ino, "a new inode means the file was replaced, not overwritten under a reader").not.toBe(before);
    expect(readClaudeUserConfig()?.data.marker).toBe("new");
    expect(readFileSync(configFile(), "utf-8").endsWith("\n")).toBe(true);
  });

  it("leaves no temp file behind when rename fails", () => {
    writeFileSync(configFile(), JSON.stringify({ projects: {} }));
    renameFails.value = true;

    expect(writeClaudeUserConfig({ projects: {} })).toBe(true);

    expect(readdirSync(claudeHome).filter((f) => f.includes("cockpit-tmp"))).toEqual([]);
  });

  // The shape that made the CLI reset on 2026-09-21, 2026-09-28 and 2026-10-09:
  // a valid document followed by the tail of a longer previous write. Writing
  // in place without truncating leaves exactly that, so the remainder is
  // padded with spaces instead, which JSON accepts.
  it("keeps the file's length and validity when a shorter document lands in place", () => {
    const long = { projects: { "/a": { note: "x".repeat(4000) } }, marker: "LONGDOC" };
    writeFileSync(configFile(), JSON.stringify(long, null, 2));
    const before = statSync(configFile()).size;
    renameFails.value = true;

    expect(writeClaudeUserConfig({ projects: {}, marker: "short" })).toBe(true);

    const text = readFileSync(configFile(), "utf-8");
    expect(statSync(configFile()).size, "the file keeps its length, so a reader never sees it shrink").toBe(before);
    expect(text, "nothing of the longer document survives but the padding").not.toContain("LONGDOC");
    expect(text.length - text.trimEnd().length, "the difference is padding, not stale JSON").toBeGreaterThan(1000);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("never truncates first, so a shorter write cannot leave an empty file", () => {
    writeFileSync(configFile(), JSON.stringify({ projects: {} }));
    renameFails.value = true;

    const fd = statSync(configFile()).ino;
    writeClaudeUserConfig({ only: "one key" });

    expect(statSync(configFile()).ino).toBe(fd);
    expect(readClaudeUserConfig()?.data).toEqual({ only: "one key" });
  });

  it("writes through a symlinked config, since that is how a mount can be avoided", () => {
    const real = path.join(claudeHome, "real-config.json");
    writeFileSync(real, JSON.stringify({ mcpServers: { gmail: {} } }));
    symlinkSync(real, configFile());

    expect(resolveClaudeUserConfigPath()).toBe(real);
    expect(
      updateClaudeUserConfig((data) => {
        data.marker = "through";
        return true;
      }),
    ).toBe(true);

    expect(JSON.parse(readFileSync(real, "utf-8")).marker).toBe("through");
  });

  it("leaves an unreadable config alone rather than replacing it with a partial merge", () => {
    writeFileSync(configFile(), "{ this is not json");
    const before = readFileSync(configFile(), "utf-8");

    expect(updateClaudeUserConfig(() => true)).toBe(false);
    expect(readFileSync(configFile(), "utf-8")).toBe(before);
  });

  it("does not write at all when the updater reports no change", () => {
    writeFileSync(configFile(), "{}");
    const before = statSync(configFile()).mtimeMs;

    expect(updateClaudeUserConfig(() => false)).toBe(false);
    expect(statSync(configFile()).mtimeMs).toBe(before);
  });
});
