import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCockpitDir } from "@/server/paths";
import type { ThinkingLevel } from "@/types";

export interface AssistantSettings {
  model: string;
  thinkingLevel: ThinkingLevel;
}

const fallback: AssistantSettings = {
  model: "sonnet",
  thinkingLevel: "high",
};

function settingsFile(): string {
  return join(getCockpitDir(), "assistant.json");
}

export function getAssistantSettings(): AssistantSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), "utf-8"));
    return { ...fallback, ...raw };
  } catch {
    return { ...fallback };
  }
}

export function updateAssistantSettings(partial: Partial<AssistantSettings>): AssistantSettings {
  const current = getAssistantSettings();
  const updated = { ...current, ...partial };
  try {
    mkdirSync(getCockpitDir(), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify(updated, null, 2) + "\n");
  } catch {
    // best effort
  }
  return updated;
}
