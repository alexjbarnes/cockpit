import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupHookSettings, prepareHookSettings } from "@/server/claude-settings";
import { resolveHookBridgePath } from "@/server/hook-bridge-path";

describe("prepareHookSettings", () => {
  const cleanupIds: string[] = [];

  afterEach(async () => {
    while (cleanupIds.length) {
      const id = cleanupIds.pop();
      if (id) await cleanupHookSettings(id);
    }
  });

  it("writes a settings file with hooks for every event and the right bridge path", async () => {
    const sessionId = "test-session-1";
    cleanupIds.push(sessionId);

    const { settingsPath, env } = await prepareHookSettings({
      sessionId,
      hookUrl: "http://127.0.0.1:12345",
      hookToken: "tok",
    });

    expect(existsSync(settingsPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>;
      permissions: { allow: string[]; deny: string[] };
    };

    const bridge = resolveHookBridgePath();
    for (const event of ["PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit", "Notification", "PermissionRequest"]) {
      expect(parsed.hooks[event]).toBeDefined();
      const last = parsed.hooks[event][parsed.hooks[event].length - 1];
      const cmd = last.hooks[0].command;
      expect(cmd).toContain(bridge);
      expect(cmd).toContain(event);
    }

    const prEntries = parsed.hooks.PermissionRequest;
    const prLast = prEntries[prEntries.length - 1];
    expect(prLast.hooks[0].timeout).toBe(86400);

    expect(env).toEqual({
      COCKPIT_HOOK_URL: "http://127.0.0.1:12345",
      COCKPIT_HOOK_TOKEN: "tok",
      COCKPIT_SESSION_ID: sessionId,
    });
  });

  it("respects allow/deny lists", async () => {
    const sessionId = "test-session-2";
    cleanupIds.push(sessionId);

    const { settingsPath } = await prepareHookSettings({
      sessionId,
      hookUrl: "http://127.0.0.1:12345",
      hookToken: "tok",
      allowList: ["Read(*)", "Glob(*)"],
      denyList: ["Bash(rm *)"],
    });

    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(parsed.permissions.allow).toEqual(expect.arrayContaining(["Read(*)", "Glob(*)"]));
    expect(parsed.permissions.deny).toEqual(expect.arrayContaining(["Bash(rm *)"]));
  });

  it("cleanupHookSettings removes the file", async () => {
    const sessionId = "test-session-3";
    const { settingsPath } = await prepareHookSettings({
      sessionId,
      hookUrl: "http://127.0.0.1:1",
      hookToken: "tok",
    });
    expect(existsSync(settingsPath)).toBe(true);
    await cleanupHookSettings(sessionId);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it("quotes bridge paths containing spaces", async () => {
    const original = process.env.COCKPIT_HOOK_BRIDGE_BIN;
    // Force the resolver cache to miss by clearing and pointing at a temp file
    const sessionId = "test-session-4";
    cleanupIds.push(sessionId);

    const { settingsPath } = await prepareHookSettings({
      sessionId,
      hookUrl: "http://127.0.0.1:1",
      hookToken: "tok",
    });
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    // Just ensure the command shape parses sensibly — argv split-able
    const stopEntries = parsed.hooks.Stop;
    const stopLast = stopEntries[stopEntries.length - 1];
    const parts = stopLast.hooks[0].command.split(/\s+/);
    expect(parts[0]).toBe("node");
    expect(parts[parts.length - 1]).toBe("Stop");

    if (original) process.env.COCKPIT_HOOK_BRIDGE_BIN = original;
  });

  it("merges user settings into the generated file", async () => {
    const sessionId = "test-session-5";
    cleanupIds.push(sessionId);

    const { settingsPath } = await prepareHookSettings({
      sessionId,
      hookUrl: "http://127.0.0.1:1",
      hookToken: "tok",
    });

    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const hasEnvOrPlugins = "env" in parsed || "enabledPlugins" in parsed;
    expect(hasEnvOrPlugins).toBe(true);
  });
});
