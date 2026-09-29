// CK-47. The pinned session and review lists were the only cockpit-owned state
// living under the CLI's directory (~/.claude/cockpit/), which meant relocating
// Claude took the sidebar with it, and COCKPIT_CONFIG_DIR — the isolation every
// test relies on — did not reach them, so a suite run rewrote the developer's
// real pins. They move to getCockpitDir() with a one-way migration on read.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPinned, writePinned } from "@/server/pinned-storage";

let root: string;
let cockpitDir: string;
let claudeDir: string;
let prevCockpit: string | undefined;
let prevClaude: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cockpit-pinned-"));
  cockpitDir = path.join(root, "cockpit-config");
  claudeDir = path.join(root, "claude-config");
  mkdirSync(cockpitDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  prevCockpit = process.env.COCKPIT_CONFIG_DIR;
  prevClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.COCKPIT_CONFIG_DIR = cockpitDir;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});

afterEach(() => {
  if (prevCockpit === undefined) delete process.env.COCKPIT_CONFIG_DIR;
  else process.env.COCKPIT_CONFIG_DIR = prevCockpit;
  if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaude;
  rmSync(root, { recursive: true, force: true });
});

/** Seed the pre-migration location: ~/.claude/cockpit/<list>. */
function seedLegacy(list: string, ids: unknown): string {
  const dir = path.join(claudeDir, "cockpit");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, list);
  writeFileSync(file, JSON.stringify(ids));
  return file;
}

const currentFile = (list: string) => path.join(cockpitDir, list);

describe("pinned lists live in the cockpit dir", () => {
  it("writes to the cockpit dir, not the Claude dir", async () => {
    await writePinned("pinned_sessions.json", ["a", "b"]);

    expect(existsSync(currentFile("pinned_sessions.json"))).toBe(true);
    expect(existsSync(path.join(claudeDir, "cockpit", "pinned_sessions.json")), "nothing new under the Claude dir").toBe(false);
    expect(await readPinned("pinned_sessions.json")).toEqual(["a", "b"]);
  });

  it("returns an empty list when nothing has been pinned anywhere", async () => {
    expect(await readPinned("pinned_sessions.json")).toEqual([]);
    expect(await readPinned("pinned_reviews.json")).toEqual([]);
  });

  it("keeps sessions and reviews separate", async () => {
    await writePinned("pinned_sessions.json", ["session-1"]);
    await writePinned("pinned_reviews.json", ["review-1"]);

    expect(await readPinned("pinned_sessions.json")).toEqual(["session-1"]);
    expect(await readPinned("pinned_reviews.json")).toEqual(["review-1"]);
  });
});

describe("migration out of the Claude dir", () => {
  it("adopts an existing list on first read, for both lists", async () => {
    seedLegacy("pinned_sessions.json", ["s1", "s2"]);
    seedLegacy("pinned_reviews.json", ["r1"]);

    expect(await readPinned("pinned_sessions.json"), "the user's pins survive the move").toEqual(["s1", "s2"]);
    expect(await readPinned("pinned_reviews.json")).toEqual(["r1"]);
    expect(JSON.parse(readFileSync(currentFile("pinned_sessions.json"), "utf-8")), "copied, so the next read needs no fallback").toEqual([
      "s1",
      "s2",
    ]);
  });

  it("leaves the old file in place, so an older cockpit still finds it", async () => {
    const legacy = seedLegacy("pinned_sessions.json", ["s1"]);
    await readPinned("pinned_sessions.json");

    expect(existsSync(legacy)).toBe(true);
    expect(JSON.parse(readFileSync(legacy, "utf-8"))).toEqual(["s1"]);
  });

  it("stops consulting the old file once the new one exists", async () => {
    seedLegacy("pinned_sessions.json", ["stale"]);
    await writePinned("pinned_sessions.json", ["current"]);

    expect(await readPinned("pinned_sessions.json"), "the new file wins outright").toEqual(["current"]);
  });

  it("does not resurrect the old list after everything is unpinned", async () => {
    // The regression this guards: treating an empty new list as "nothing here,
    // try the old file" would bring deleted pins back on the next page load.
    seedLegacy("pinned_sessions.json", ["s1", "s2"]);
    await readPinned("pinned_sessions.json");
    await writePinned("pinned_sessions.json", []);

    expect(await readPinned("pinned_sessions.json")).toEqual([]);
  });

  it("survives a corrupt file at either end", async () => {
    mkdirSync(path.join(claudeDir, "cockpit"), { recursive: true });
    writeFileSync(path.join(claudeDir, "cockpit", "pinned_sessions.json"), "{ not json");
    expect(await readPinned("pinned_sessions.json"), "a corrupt old file reads as no pins").toEqual([]);

    writeFileSync(currentFile("pinned_reviews.json"), "also not json");
    expect(await readPinned("pinned_reviews.json"), "and so does a corrupt current one").toEqual([]);
  });

  it("ignores non-string entries rather than handing them to the sidebar", async () => {
    seedLegacy("pinned_sessions.json", ["ok", 42, null, { id: "nope" }, "fine"]);
    expect(await readPinned("pinned_sessions.json")).toEqual(["ok", "fine"]);
  });

  it("treats a file that is not an array as no pins", async () => {
    writeFileSync(currentFile("pinned_sessions.json"), JSON.stringify({ pinned: ["a"] }));
    expect(await readPinned("pinned_sessions.json")).toEqual([]);
  });

  it("creates the cockpit dir when it does not exist yet", async () => {
    rmSync(cockpitDir, { recursive: true, force: true });
    await writePinned("pinned_reviews.json", ["r1"]);

    expect(await readPinned("pinned_reviews.json")).toEqual(["r1"]);
  });
});
