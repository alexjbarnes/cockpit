// A scheduled job whose scratchpad had no trust entry in ~/.claude.json died at
// spawn: the CLI raised its workspace-trust dialog, cockpit typed the prompt
// into it, and the run reported "went idle without producing any assistant
// message" with no transcript and no mention of trust. Cockpit creates those
// directories, so it grants the trust up front.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureScratchpadTrusted, isCockpitOwnedScratchpad, isDirectoryTrusted, trustDirectory } from "@/server/workspace-trust";

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

describe("isCockpitOwnedScratchpad", () => {
  it("accepts a job scratchpad", () => {
    expect(isCockpitOwnedScratchpad(scratchpad("job-1"))).toBe(true);
  });

  // Trusting the user's own code is their decision, not cockpit's. A job with
  // its own cwd must never be auto-trusted.
  it("rejects a directory outside the scratchpad root", () => {
    expect(isCockpitOwnedScratchpad("/home/dev/repos/cockpit")).toBe(false);
    expect(isCockpitOwnedScratchpad(path.join(cockpitDir, "issues"))).toBe(false);
  });

  it("is not fooled by a sibling that merely shares the prefix, or by traversal", () => {
    expect(isCockpitOwnedScratchpad(`${path.join(cockpitDir, "jobs")}-evil`)).toBe(false);
    expect(isCockpitOwnedScratchpad(path.join(cockpitDir, "jobs", "..", "..", "elsewhere"))).toBe(false);
  });
});

describe("ensureScratchpadTrusted", () => {
  it("adds the trust flag for a scratchpad that has no entry", () => {
    writeConfig({ projects: {} });
    const dir = scratchpad("job-1");

    expect(ensureScratchpadTrusted(dir)).toBe(true);
    expect(readConfig().projects?.[dir]).toEqual({ hasTrustDialogAccepted: true });
  });

  it("creates the projects map when the config has none", () => {
    writeConfig({ hasCompletedOnboarding: true });
    const dir = scratchpad("job-1");

    expect(ensureScratchpadTrusted(dir)).toBe(true);
    expect(readConfig().projects?.[dir]?.hasTrustDialogAccepted).toBe(true);
  });

  // The CLI keeps real per-project state on these entries — allowed tools, MCP
  // choices, last-run stats. Only the trust flag is cockpit's to set.
  it("preserves an existing entry's other fields", () => {
    const dir = scratchpad("job-1");
    writeConfig({ projects: { [dir]: { allowedTools: ["Bash"], lastCost: 1.23 } } });

    expect(ensureScratchpadTrusted(dir)).toBe(true);
    expect(readConfig().projects?.[dir]).toEqual({ allowedTools: ["Bash"], lastCost: 1.23, hasTrustDialogAccepted: true });
  });

  it("does nothing when the directory is already trusted", () => {
    const dir = scratchpad("job-1");
    writeConfig({ projects: { [dir]: { hasTrustDialogAccepted: true } } });
    const before = readFileSync(configFile(), "utf-8");

    expect(ensureScratchpadTrusted(dir)).toBe(false);
    expect(readFileSync(configFile(), "utf-8"), "an untouched config cannot race the CLI's own writes").toBe(before);
  });

  it("leaves a job's own cwd alone", () => {
    writeConfig({ projects: {} });

    expect(ensureScratchpadTrusted("/home/dev/repos/cockpit")).toBe(false);
    expect(readConfig().projects).toEqual({});
  });

  // Best effort: a job that cannot be pre-trusted should still be attempted.
  it("reports false rather than throwing when the config is missing or corrupt", () => {
    const dir = scratchpad("job-1");
    expect(existsSync(configFile())).toBe(false);
    expect(ensureScratchpadTrusted(dir)).toBe(false);

    writeFileSync(configFile(), "{ not json");
    expect(ensureScratchpadTrusted(dir)).toBe(false);
  });
});

// The session half: a directory the user picks is theirs to trust, so the grant
// is unfenced — unlike the scratchpad path, which decides for itself and is
// therefore limited to directories cockpit created.
describe("trustDirectory and isDirectoryTrusted", () => {
  it("reports an untrusted directory as untrusted, then trusted once granted", () => {
    writeConfig({ projects: {} });
    const dir = "/home/dev/repos/somewhere";

    expect(isDirectoryTrusted(dir)).toBe(false);
    expect(trustDirectory(dir)).toBe(true);
    expect(isDirectoryTrusted(dir)).toBe(true);
  });

  it("grants a directory outside the scratchpad root, which the scratchpad path refuses", () => {
    writeConfig({ projects: {} });
    const dir = "/home/dev/repos/cockpit";

    expect(ensureScratchpadTrusted(dir), "cockpit never decides this for itself").toBe(false);
    expect(trustDirectory(dir), "but the user can").toBe(true);
    expect(readConfig().projects?.[dir]?.hasTrustDialogAccepted).toBe(true);
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
