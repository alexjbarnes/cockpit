// The shared sandbox rules live in the user's own Claude settings file, which
// every Claude session reads. These tests run against a throwaway config dir:
// the module writes that file, and the developer's real ~/.claude must never be
// the one it writes.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxRules } from "@/types";

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));

import { GET, PUT } from "@/app/api/sandbox/rules/route";
import {
  applySandboxRules,
  EMPTY_SANDBOX_RULES,
  isValidDomainEntry,
  parseSandboxRules,
  policySettingsPath,
  readSandboxRules,
  SandboxRulesError,
  sandboxEscapePossible,
  writeSandboxRules,
} from "@/server/claude-sandbox-rules";

const root = mkdtempSync(join(tmpdir(), "cockpit-sandbox-rules-"));
const claudeDir = join(root, "claude");
const settingsFile = join(claudeDir, "settings.json");
process.env.CLAUDE_CONFIG_DIR = claudeDir;

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  rmSync(claudeDir, { recursive: true, force: true });
});

const writeSettings = (value: unknown) => {
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsFile, typeof value === "string" ? value : JSON.stringify(value));
};
const fileJson = () => JSON.parse(readFileSync(settingsFile, "utf-8")) as Record<string, unknown>;

const rules = (over: Partial<SandboxRules>): SandboxRules => ({ ...EMPTY_SANDBOX_RULES, ...over });

describe("readSandboxRules", () => {
  it("reads a missing file as no rules", async () => {
    const read = await readSandboxRules();
    expect(read).toEqual({ path: settingsFile, rules: EMPTY_SANDBOX_RULES, version: "" });
  });

  it("reads the fields cockpit edits, and reports the file's own enabled flag", async () => {
    writeSettings({
      sandbox: {
        enabled: true,
        excludedCommands: ["docker *"],
        allowUnsandboxedCommands: false,
        network: { allowedDomains: ["github.com"], deniedDomains: ["bad.example.com"], allowLocalBinding: true, allowUnixSockets: ["/s"] },
        filesystem: { allowWrite: ["~/.npm"], denyWrite: ["~/.ssh"], denyRead: ["~/.aws"], allowRead: ["~/.aws/config"] },
      },
    });
    const read = await readSandboxRules();
    expect(read.enabledInFile).toBe(true);
    expect(read.rules).toEqual({
      allowedDomains: ["github.com"],
      deniedDomains: ["bad.example.com"],
      allowUnixSockets: ["/s"],
      allowLocalBinding: true,
      allowWrite: ["~/.npm"],
      denyWrite: ["~/.ssh"],
      denyRead: ["~/.aws"],
      allowRead: ["~/.aws/config"],
      excludedCommands: ["docker *"],
      allowUnsandboxedCommands: false,
    });
  });

  it("ignores malformed values inside an otherwise valid file", async () => {
    writeSettings({ sandbox: { network: { allowedDomains: "github.com", deniedDomains: [1, "ok.example.com"] }, filesystem: [] } });
    const read = await readSandboxRules();
    expect(read.rules.allowedDomains).toEqual([]);
    expect(read.rules.deniedDomains).toEqual(["ok.example.com"]);
    expect(read.rules.allowWrite).toEqual([]);
  });

  it("reads an empty file as no rules", async () => {
    writeSettings("   \n");
    expect((await readSandboxRules()).rules).toEqual(EMPTY_SANDBOX_RULES);
  });

  it("refuses a file that is not valid JSON rather than treating it as empty", async () => {
    writeSettings("{ not json");
    await expect(readSandboxRules()).rejects.toMatchObject({ status: 409 });
  });
});

describe("writeSandboxRules", () => {
  it("creates the file when there is none", async () => {
    const saved = await writeSandboxRules(rules({ allowedDomains: ["github.com"], allowLocalBinding: true }));
    expect(fileJson()).toEqual({ sandbox: { network: { allowedDomains: ["github.com"], allowLocalBinding: true } } });
    expect(saved.rules.allowedDomains).toEqual(["github.com"]);
  });

  it("keeps every other setting, and every sandbox key it does not edit", async () => {
    writeSettings({
      model: "opus",
      hooks: { Stop: [] },
      sandbox: { enabled: true, ignoreViolations: { "*": ["/x"] }, network: { httpProxyPort: 8080, allowedDomains: ["old.example.com"] } },
    });
    await writeSandboxRules(rules({ allowedDomains: ["new.example.com"], excludedCommands: ["make test"] }));
    expect(fileJson()).toEqual({
      model: "opus",
      hooks: { Stop: [] },
      sandbox: {
        enabled: true,
        ignoreViolations: { "*": ["/x"] },
        excludedCommands: ["make test"],
        network: { httpProxyPort: 8080, allowedDomains: ["new.example.com"] },
      },
    });
  });

  it("removes a cleared rule instead of writing it empty, and drops blocks left with nothing in them", async () => {
    writeSettings({
      sandbox: { excludedCommands: ["x"], network: { allowedDomains: ["a.example.com"] }, filesystem: { denyRead: ["/y"] } },
    });
    await writeSandboxRules(EMPTY_SANDBOX_RULES);
    expect(fileJson()).toEqual({});
  });

  it("refuses a save made from a read the file has since moved on from", async () => {
    writeSettings({ sandbox: { network: { allowedDomains: ["a.example.com"] } } });
    const { version } = await readSandboxRules();
    // Claude Code saves a host of its own in between (an "always allow" answer).
    writeSettings({ sandbox: { network: { allowedDomains: ["a.example.com", "b.example.com"] } } });

    await expect(writeSandboxRules(rules({ allowedDomains: ["a.example.com"] }), version)).rejects.toMatchObject({ status: 409 });
    expect(fileJson()).toEqual({ sandbox: { network: { allowedDomains: ["a.example.com", "b.example.com"] } } });

    const fresh = await readSandboxRules();
    const saved = await writeSandboxRules(rules({ allowedDomains: ["c.example.com"] }), fresh.version);
    expect(saved.rules.allowedDomains).toEqual(["c.example.com"]);
    expect(saved.version).not.toBe(fresh.version);
  });

  it("writes through a symlinked settings file, which stays a symlink", async () => {
    const real = join(root, "dotfiles-settings.json");
    writeFileSync(real, JSON.stringify({ model: "opus" }));
    mkdirSync(claudeDir, { recursive: true });
    symlinkSync(real, settingsFile);

    await writeSandboxRules(rules({ denyRead: ["~/.aws"] }));

    expect(lstatSync(settingsFile).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf-8"))).toEqual({ model: "opus", sandbox: { filesystem: { denyRead: ["~/.aws"] } } });
    rmSync(real, { force: true });
  });

  it("leaves a file it cannot parse exactly as it was", async () => {
    writeSettings("{ broken");
    await expect(writeSandboxRules(rules({ allowedDomains: ["github.com"] }))).rejects.toBeInstanceOf(SandboxRulesError);
    expect(readFileSync(settingsFile, "utf-8")).toBe("{ broken");
  });

  it("refuses a file whose top level is not an object", async () => {
    writeSettings("[1, 2]");
    await expect(writeSandboxRules(EMPTY_SANDBOX_RULES)).rejects.toMatchObject({ status: 409 });
  });

  it("reports a write it could not make", async () => {
    // The config dir is a file, so nothing can be created under it.
    mkdirSync(root, { recursive: true });
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "");
    process.env.CLAUDE_CONFIG_DIR = blocked;
    await expect(writeSandboxRules(EMPTY_SANDBOX_RULES)).rejects.toMatchObject({ status: 409 });
  });
});

describe("applySandboxRules", () => {
  it("replaces a sandbox value that is not an object", () => {
    expect(applySandboxRules({ sandbox: "on" }, rules({ denyRead: ["~/.aws"] }))).toEqual({
      sandbox: { filesystem: { denyRead: ["~/.aws"] } },
    });
  });
});

describe("parseSandboxRules", () => {
  it("trims, drops blanks and duplicates, and treats a missing list as empty", () => {
    expect(parseSandboxRules({ allowedDomains: [" github.com ", "", "github.com"], allowLocalBinding: null })).toEqual({
      ...EMPTY_SANDBOX_RULES,
      allowedDomains: ["github.com"],
    });
  });

  it("keeps a flag only when it is set", () => {
    expect(parseSandboxRules({ allowUnsandboxedCommands: false, allowLocalBinding: true })).toMatchObject({
      allowUnsandboxedCommands: false,
      allowLocalBinding: true,
    });
  });

  it.each([
    ["a non-object body", []],
    ["a list that is not a list", { excludedCommands: "docker" }],
    ["a list holding a non-string", { allowWrite: [1] }],
    ["a domain the sandbox refuses", { allowedDomains: ["https://github.com"] }],
    ["an entry with a line break", { denyRead: ["a\nb"] }],
    ["a flag that is not a boolean", { allowLocalBinding: "yes" }],
  ])("rejects %s", (_label, body) => {
    expect(() => parseSandboxRules(body)).toThrow(SandboxRulesError);
  });
});

describe("isValidDomainEntry", () => {
  it.each([
    "github.com",
    "*.npmjs.org",
    "api.example.co.uk:443",
    "localhost",
    "localhost:3000",
    "127.0.0.1",
    "127.0.0.1:5432",
    "[::1]",
    "[::1]:8080",
    "example.com:65535",
  ])("accepts %s", (d) => expect(isValidDomainEntry(d)).toBe(true));

  it.each([
    "*",
    "*.com",
    "https://github.com",
    "github.com/path",
    "intranet",
    "-bad.example.com",
    "a..b.com",
    "example.com:0",
    "example.com:65536",
  ])("refuses %s", (d) => expect(isValidDomainEntry(d)).toBe(false));
});

describe("sandboxEscapePossible", () => {
  const cwd = join(root, "project");
  const writeProject = (name: string, value: unknown) => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", name), JSON.stringify(value));
  };

  beforeEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("is false when the session's sandbox is off: the flag has nothing to leave", async () => {
    expect(await sandboxEscapePossible(cwd, false)).toBe(false);
  });

  it("is true for a sandboxed session with no source disallowing it", async () => {
    expect(await sandboxEscapePossible(cwd, true)).toBe(true);
  });

  it("is false when the user's settings disallow unsandboxed commands", async () => {
    writeSettings({ sandbox: { allowUnsandboxedCommands: false } });
    expect(await sandboxEscapePossible(cwd, true)).toBe(false);
  });

  it("takes the first source that decides, in the CLI's precedence order", async () => {
    writeSettings({ sandbox: { allowUnsandboxedCommands: false } });
    writeProject("settings.local.json", { sandbox: { allowUnsandboxedCommands: true } });
    expect(await sandboxEscapePossible(cwd, true)).toBe(true);

    rmSync(cwd, { recursive: true, force: true });
    writeProject("settings.json", { sandbox: { allowUnsandboxedCommands: false } });
    expect(await sandboxEscapePossible(cwd, true)).toBe(false);
  });
});

describe("policySettingsPath", () => {
  it("names the file per platform, and none where it has no fixed place", () => {
    expect(policySettingsPath("darwin")).toBe("/Library/Application Support/ClaudeCode/managed-settings.json");
    expect(policySettingsPath("linux")).toBe("/etc/claude-code/managed-settings.json");
    expect(policySettingsPath("win32")).toBeNull();
  });
});

describe("/api/sandbox/rules", () => {
  const request = (method: string, body?: unknown, token = "valid") =>
    new NextRequest("http://localhost/api/sandbox/rules", {
      method,
      headers: { cookie: `cockpit_session=${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });

  it("refuses an unauthenticated caller", async () => {
    expect((await GET(request("GET", undefined, "nope"))).status).toBe(401);
    expect((await PUT(request("PUT", {}, "nope"))).status).toBe(401);
  });

  it("round-trips the rules through the file", async () => {
    const put = await PUT(request("PUT", { allowedDomains: ["github.com"], excludedCommands: ["docker compose *"] }));
    expect(put.status).toBe(200);
    const got = await GET(request("GET"));
    expect(((await got.json()) as { rules: SandboxRules }).rules).toMatchObject({
      allowedDomains: ["github.com"],
      excludedCommands: ["docker compose *"],
    });
  });

  it("answers 409 to a save based on a stale read", async () => {
    await PUT(request("PUT", { allowedDomains: ["a.example.com"] }));
    const { version } = (await (await GET(request("GET"))).json()) as { version: string };
    writeSettings({ sandbox: { network: { allowedDomains: ["a.example.com", "b.example.com"] } } });
    expect((await PUT(request("PUT", { allowedDomains: ["a.example.com"], baseVersion: version }))).status).toBe(409);
  });

  it("answers 400 for a bad body and 409 for a file it will not rewrite", async () => {
    expect((await PUT(request("PUT", "not json"))).status).toBe(400);
    expect((await PUT(request("PUT", { allowedDomains: ["*"] }))).status).toBe(400);
    writeSettings("{ broken");
    expect((await PUT(request("PUT", {}))).status).toBe(409);
    expect((await GET(request("GET"))).status).toBe(409);
  });
});
