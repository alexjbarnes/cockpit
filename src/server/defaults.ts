import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ThinkingLevel } from "@/types";

export type DiffStyle = "split" | "unified";

export interface AppDefaults {
  thinkingLevel: ThinkingLevel;
  bypassAllPermissions: boolean;
  diffStyle: DiffStyle;
  dismissKeyboardOnSend: boolean;
  thinkingExpanded: boolean;
}

const PREFS_DIR = join(homedir(), ".aperture");
const DEFAULTS_FILE = join(PREFS_DIR, "defaults.json");

const fallback: AppDefaults = {
  thinkingLevel: "high",
  bypassAllPermissions: false,
  diffStyle: "split",
  dismissKeyboardOnSend: true,
  thinkingExpanded: false,
};

let cache: AppDefaults | null = null;

export function getDefaults(): AppDefaults {
  if (cache) return cache;
  try {
    cache = { ...fallback, ...JSON.parse(readFileSync(DEFAULTS_FILE, "utf-8")) };
    return cache!;
  } catch {
    cache = { ...fallback };
    return cache;
  }
}

export function setDefaults(partial: Partial<AppDefaults>): AppDefaults {
  const current = getDefaults();
  cache = { ...current, ...partial };
  try {
    mkdirSync(PREFS_DIR, { recursive: true });
    writeFileSync(DEFAULTS_FILE, JSON.stringify(cache, null, 2) + "\n");
  } catch {
    // best effort
  }
  return cache;
}
