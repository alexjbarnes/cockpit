import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCockpitDir } from "@/server/paths";
import type { NotificationSettings, SessionNotifications } from "@/types";

function configDir(): string {
  return getCockpitDir();
}
function configFile(): string {
  return join(configDir(), "notifications.json");
}

const fallback: NotificationSettings = {
  providers: [],
};

/** A session's notification choice as it may arrive in a create request. A
 *  provider id is required; `events` keeps only the three booleans it knows.
 *  Anything unusable is undefined, which means silent, not "guess". */
export function parseSessionNotifications(v: unknown): SessionNotifications | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { providerId, events } = v as Record<string, unknown>;
  if (typeof providerId !== "string" || !providerId.trim()) return undefined;
  const out: SessionNotifications = { providerId: providerId.trim() };
  if (typeof events === "object" && events !== null) {
    const kept: NonNullable<SessionNotifications["events"]> = {};
    for (const kind of ["finished", "question", "permission"] as const) {
      const value = (events as Record<string, unknown>)[kind];
      if (typeof value === "boolean") kept[kind] = value;
    }
    if (Object.keys(kept).length > 0) out.events = kept;
  }
  return out;
}

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
