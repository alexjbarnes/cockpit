import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NotificationSettings } from "@/types";

const CONFIG_DIR = join(homedir(), ".cockpit");
const CONFIG_FILE = join(CONFIG_DIR, "notifications.json");

const fallback: NotificationSettings = {
  providers: [],
};

export function getNotificationSettings(): NotificationSettings {
  try {
    return { ...fallback, ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) };
  } catch {
    return { ...fallback };
  }
}

export function setNotificationSettings(settings: NotificationSettings): NotificationSettings {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // best effort
  }
  return settings;
}

export function updateNotificationSettings(partial: Partial<NotificationSettings>): NotificationSettings {
  const current = getNotificationSettings();
  const updated = { ...current, ...partial };
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2) + "\n");
  return updated;
}
