import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCockpitDir } from "@/server/paths";
import type { NotificationSettings } from "@/types";

function configDir(): string {
  return getCockpitDir();
}
function configFile(): string {
  return join(configDir(), "notifications.json");
}

const fallback: NotificationSettings = {
  providers: [],
};

export function getNotificationSettings(): NotificationSettings {
  try {
    return { ...fallback, ...JSON.parse(readFileSync(configFile(), "utf-8")) };
  } catch {
    return { ...fallback };
  }
}

export function setNotificationSettings(settings: NotificationSettings): NotificationSettings {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configFile(), JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // best effort
  }
  return settings;
}

export function updateNotificationSettings(partial: Partial<NotificationSettings>): NotificationSettings {
  const current = getNotificationSettings();
  const updated = { ...current, ...partial };
  if (!existsSync(configDir())) mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(updated, null, 2) + "\n");
  return updated;
}
