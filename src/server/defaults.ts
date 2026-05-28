import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCockpitDir } from "@/server/paths";
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

function prefsDir(): string {
  return getCockpitDir();
}
function defaultsFile(): string {
  return join(prefsDir(), "defaults.json");
}

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
    const raw = JSON.parse(readFileSync(defaultsFile(), "utf-8"));
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
    mkdirSync(prefsDir(), { recursive: true });
    writeFileSync(defaultsFile(), JSON.stringify(updated, null, 2) + "\n");
  } catch {
    // best effort
  }
  return updated;
}
