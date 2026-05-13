import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelSlots, ThinkingLevel } from "@/types";

export type DiffStyle = "split" | "unified";

export interface AppDefaults {
  thinkingLevel: ThinkingLevel;
  bypassAllPermissions: boolean;
  diffStyle: DiffStyle;
  dismissKeyboardOnSend: boolean;
  thinkingExpanded: boolean;
  readExpanded: boolean;
  editExpanded: boolean;
  toolCallsExpanded: boolean;
  modelSlots: ModelSlots;
  messageStitching: boolean;
  reviewsEnabled: boolean;
}

const PREFS_DIR = join(homedir(), ".cockpit");
const DEFAULTS_FILE = join(PREFS_DIR, "defaults.json");

const fallback: AppDefaults = {
  thinkingLevel: "high",
  bypassAllPermissions: false,
  diffStyle: "split",
  dismissKeyboardOnSend: true,
  thinkingExpanded: false,
  readExpanded: false,
  editExpanded: false,
  toolCallsExpanded: false,
  modelSlots: { main: "sonnet" },
  messageStitching: true,
  reviewsEnabled: true,
};

export function getDefaults(): AppDefaults {
  try {
    const raw = JSON.parse(readFileSync(DEFAULTS_FILE, "utf-8"));
    if (raw.model && !raw.modelSlots) {
      raw.modelSlots = { main: raw.model };
      delete raw.model;
    }
    return { ...fallback, ...raw };
  } catch {
    return { ...fallback };
  }
}

export function setDefaults(partial: Partial<AppDefaults>): AppDefaults {
  const current = getDefaults();
  const updated = { ...current, ...partial };
  try {
    mkdirSync(PREFS_DIR, { recursive: true });
    writeFileSync(DEFAULTS_FILE, JSON.stringify(updated, null, 2) + "\n");
  } catch {
    // best effort
  }
  return updated;
}
