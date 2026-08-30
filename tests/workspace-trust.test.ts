// A scheduled job whose scratchpad had no trust entry in ~/.claude.json died at
// spawn: the CLI raised its workspace-trust dialog, cockpit typed the prompt
// into it, and the run reported "went idle without producing any assistant
// message" with no transcript and no mention of trust. Cockpit creates those
// directories, so it grants the trust up front.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
