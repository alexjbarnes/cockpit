// A scheduled job whose scratchpad had no trust entry in ~/.claude.json died at
// spawn: the CLI raised its workspace-trust dialog, cockpit typed the prompt
// into it, and the run reported "went idle without producing any assistant
// message" with no transcript and no mention of trust. Cockpit creates those
// directories, so it grants the trust up front.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Rename is unavailable when the config path is its own mount (this project's
// dev container). Everything else stays real so the write is genuinely exercised.
const { renameFails } = vi.hoisted(() => ({ renameFails: { value: false } }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (renameFails.value) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return actual.renameSync(from, to);
    },
  };
});

import { isDirectoryTrusted, trustDirectory } from "@/server/workspace-trust";

let root: string;
let cockpitDir: string;
let claudeHome: string;
let prevCockpit: string | undefined;
let prevClaude: string | undefined;

const configFile = () => path.join(claudeHome, ".claude.json");
const scratchpad = (jobId: string) => path.join(cockpitDir, "jobs", jobId);

function writeConfig(value: unknown): void {
  writeFileSync(configFile(), JSON.stringify(value, null, 2));
}
function readConfig(): { projects?: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(configFile(), "utf-8"));
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cockpit-trust-"));
  cockpitDir = path.join(root, "cockpit");
  claudeHome = path.join(root, "home");
  mkdirSync(path.join(cockpitDir, "jobs"), { recursive: true });
  mkdirSync(claudeHome, { recursive: true });
  prevCockpit = process.env.COCKPIT_CONFIG_DIR;
  prevClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.COCKPIT_CONFIG_DIR = cockpitDir;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
});

afterEach(() => {
  if (prevCockpit === undefined) delete process.env.COCKPIT_CONFIG_DIR;
  else process.env.COCKPIT_CONFIG_DIR = prevCockpit;
  if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaude;
  rmSync(root, { recursive: true, force: true });
});

// Two callers, both of them the user's say-so: the "Trust this directory"
// button on a session that could not start, and a scheduled job about to run
// unattended in a directory its author chose. There is no fence — cockpit never
// decides this for itself.
describe("trustDirectory and isDirectoryTrusted", () => {
  it("reports an untrusted directory as untrusted, then trusted once granted", () => {
    writeConfig({ projects: {} });
    const dir = "/home/dev/repos/somewhere";

    expect(isDirectoryTrusted(dir)).toBe(false);
    expect(trustDirectory(dir)).toBe(true);
    expect(isDirectoryTrusted(dir)).toBe(true);
  });

  it("grants a scratchpad and a real project alike", () => {
    writeConfig({ projects: {} });

    expect(trustDirectory(scratchpad("job-1"))).toBe(true);
    expect(trustDirectory("/home/dev/repos/cockpit")).toBe(true);
    expect(readConfig().projects?.[scratchpad("job-1")]?.hasTrustDialogAccepted).toBe(true);
    expect(readConfig().projects?.["/home/dev/repos/cockpit"]?.hasTrustDialogAccepted).toBe(true);
  });

  it("creates the projects map when the config has none", () => {
    writeConfig({ hasCompletedOnboarding: true });
    const dir = scratchpad("job-1");

    expect(trustDirectory(dir)).toBe(true);
    expect(readConfig().projects?.[dir]?.hasTrustDialogAccepted).toBe(true);
  });

  // The CLI keeps real per-project state on these entries — allowed tools, MCP
  // choices, last-run stats. Only the trust flag is cockpit's to set.
  it("preserves an existing entry's other fields", () => {
    const dir = scratchpad("job-1");
    writeConfig({ projects: { [dir]: { allowedTools: ["Bash"], lastCost: 1.23 } } });

    expect(trustDirectory(dir)).toBe(true);
    expect(readConfig().projects?.[dir]).toEqual({ allowedTools: ["Bash"], lastCost: 1.23, hasTrustDialogAccepted: true });
  });

  it("leaves an already-trusted config byte-identical, so it cannot race the CLI's own writes", () => {
    const dir = scratchpad("job-1");
    writeConfig({ projects: { [dir]: { hasTrustDialogAccepted: true } } });
    const before = readFileSync(configFile(), "utf-8");

    expect(trustDirectory(dir)).toBe(false);
    expect(readFileSync(configFile(), "utf-8")).toBe(before);
  });

  // Best effort: a job that cannot be pre-trusted should still be attempted.
  it("reports false rather than throwing when the config is missing or corrupt", () => {
    expect(existsSync(configFile())).toBe(false);
    expect(trustDirectory(scratchpad("job-1"))).toBe(false);

    writeFileSync(configFile(), "{ not json");
    expect(trustDirectory(scratchpad("job-1"))).toBe(false);
  });

  it("treats an already-trusted directory as a no-op the caller can still call twice", () => {
    const dir = "/home/dev/repos/somewhere";
    writeConfig({ projects: { [dir]: { hasTrustDialogAccepted: true } } });

    expect(trustDirectory(dir)).toBe(false);
    expect(isDirectoryTrusted(dir), "a double click must still leave it trusted").toBe(true);
  });

  it("reports untrusted rather than throwing when the config is unreadable", () => {
    writeFileSync(configFile(), "{ not json");
    expect(isDirectoryTrusted("/anything")).toBe(false);
  });
});

// The CLI owns ~/.claude.json and writes it whenever it likes, so cockpit is
// one of two uncoordinated writers. On 2026-09-01 a non-atomic write left the
// file as a complete document with the tail of a longer previous write still
// attached; the CLI quarantined it and reset, losing eleven trusted
// directories. Cockpit's half of the write has to be indivisible.
describe("the config write cannot be seen half-done", () => {
  it("replaces the file rather than truncating it in place", () => {
    const dir = "/home/dev/repos/somewhere";
    const bulky = {
      projects: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`/p/${i}`, { lastCost: i, note: "x".repeat(80) }])),
    };
    writeConfig(bulky);
    const before = statSync(configFile()).ino;

    expect(trustDirectory(dir)).toBe(true);

    // A new inode means rename swapped the file in whole. That is the property
    // that matters: the CLI reading concurrently holds the OLD complete file
    // instead of watching this one shrink to nothing and grow back. Truncating
    // in place keeps the inode and is what left a valid document with the tail
    // of a longer previous write still attached.
    expect(statSync(configFile()).ino, "the config is swapped in, not overwritten under readers").not.toBe(before);
    expect(() => JSON.parse(readFileSync(configFile(), "utf-8"))).not.toThrow();
    expect(readConfig().projects?.[dir]?.hasTrustDialogAccepted).toBe(true);
    expect(Object.keys(readConfig().projects ?? {}), "the rest of the config survives").toHaveLength(401);
  });

  it("leaves no temp file behind", () => {
    writeConfig({ projects: {} });
    expect(trustDirectory("/home/dev/repos/somewhere")).toBe(true);

    const strays = readdirSync(claudeHome).filter((f) => f.includes("cockpit-tmp"));
    expect(strays).toEqual([]);
  });

  // Rename is unavailable when the config path is its own mount (the dev
  // container). The write still has to land, and still has to be complete.
  it("falls back to an in-place write when rename cannot be used, and still writes valid JSON", () => {
    renameFails.value = true;
    try {
      writeConfig({ projects: { "/keep/me": { lastCost: 9 } } });
      const inoBefore = statSync(configFile()).ino;
      expect(trustDirectory("/home/dev/repos/somewhere")).toBe(true);

      const cfg = readConfig();
      expect(cfg.projects?.["/home/dev/repos/somewhere"]?.hasTrustDialogAccepted).toBe(true);
      expect(cfg.projects?.["/keep/me"]).toEqual({ lastCost: 9 });
      expect(statSync(configFile()).ino, "same file, written through — the unavoidable case").toBe(inoBefore);
      expect(readdirSync(claudeHome).filter((f) => f.includes("cockpit-tmp"))).toEqual([]);
    } finally {
      renameFails.value = false;
    }
  });
});
