import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DIR = vi.hoisted(() => {
  const p = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");
  return p.join(os.tmpdir(), `cockpit-notif-test-${process.pid}`);
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => TEST_DIR };
});

const CONFIG_DIR = join(TEST_DIR, ".cockpit");
const CONFIG_FILE = join(CONFIG_DIR, "notifications.json");

describe("notification-settings", () => {
  beforeEach(() => {
    vi.resetModules();
    mkdirSync(CONFIG_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns empty providers when no config file exists", async () => {
    const { getNotificationSettings } = await import("@/server/notification-settings");
    const settings = getNotificationSettings();
    expect(settings.providers).toEqual([]);
  });

  it("reads settings from config file", async () => {
    const data = { providers: [{ id: "t1", type: "telegram", enabled: true, name: "TG", config: { botToken: "x", chatId: "1" } }] };
    writeFileSync(CONFIG_FILE, JSON.stringify(data));
    const { getNotificationSettings } = await import("@/server/notification-settings");
    const settings = getNotificationSettings();
    expect(settings.providers).toHaveLength(1);
    expect(settings.providers[0].id).toBe("t1");
  });

  it("returns fallback when config file has invalid JSON", async () => {
    writeFileSync(CONFIG_FILE, "not json");
    const { getNotificationSettings } = await import("@/server/notification-settings");
    const settings = getNotificationSettings();
    expect(settings.providers).toEqual([]);
  });

  it("setNotificationSettings persists to file", async () => {
    const { setNotificationSettings } = await import("@/server/notification-settings");
    const input = {
      providers: [{ id: "n1", type: "ntfy" as const, enabled: true, name: "N", config: { serverUrl: "https://ntfy.sh", topic: "t" } }],
    };
    const result = setNotificationSettings(input);
    expect(result).toEqual(input);
    const written = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    expect(written.providers[0].id).toBe("n1");
  });

  it("updateNotificationSettings merges with existing", async () => {
    const initial = { baseUrl: "https://old.com", providers: [] as [] };
    writeFileSync(CONFIG_FILE, JSON.stringify(initial));
    const { updateNotificationSettings } = await import("@/server/notification-settings");
    const result = updateNotificationSettings({ baseUrl: "https://new.com" });
    expect(result.baseUrl).toBe("https://new.com");
    expect(result.providers).toEqual([]);
  });

  it("updateNotificationSettings creates config dir if needed", async () => {
    rmSync(CONFIG_DIR, { recursive: true, force: true });
    const { updateNotificationSettings } = await import("@/server/notification-settings");
    const result = updateNotificationSettings({ providers: [] });
    expect(result.providers).toEqual([]);
    const written = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    expect(written.providers).toEqual([]);
  });

  it("merges baseUrl from file with fallback", async () => {
    writeFileSync(CONFIG_FILE, JSON.stringify({ baseUrl: "https://my.app", providers: [] }));
    const { getNotificationSettings } = await import("@/server/notification-settings");
    const settings = getNotificationSettings();
    expect(settings.baseUrl).toBe("https://my.app");
  });
});
