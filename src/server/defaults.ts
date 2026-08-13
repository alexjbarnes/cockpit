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
  /**
   * Native issue tracker (Issues sidebar icon, /issues pages, Projects
   * settings, the seven issue/project MCP tools). Off by default: it's
   * experimental and gates surfaces across server/MCP/UI — see the MCP tool
   * handlers in cockpit-config-server.ts for the enforcement.
   */
  issuesEnabled: boolean;
  /**
   * Opt in to Sonnet 4.6's 1M context window. Off by default because it needs
   * usage credits (claude.ai/settings/usage) and silently runs at 200K without
   * them. When on, cockpit requests 1M for Sonnet 4.6 and surfaces the credits
   * error if it's not actually enabled. Other models' 1M is unaffected.
   */
  allowSonnet1m: boolean;
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
  issuesEnabled: false,
  allowSonnet1m: false,
};

/**
 * Env override for the experimental issue tracker, so a dev run can start with
 * it on without flipping the Settings toggle — and, because it never reaches
 * defaults.json, without leaving it on for the next ordinary run. Unset (the
 * normal case) changes nothing; any other value than the two recognised below
 * is ignored rather than guessed at.
 */
function issuesEnabledOverride(): boolean | undefined {
  const raw = process.env.COCKPIT_ISSUES_ENABLED;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return undefined;
}

export function getDefaults(): AppDefaults {
  const override = issuesEnabledOverride();
  const withOverride = (d: AppDefaults): AppDefaults => (override === undefined ? d : { ...d, issuesEnabled: override });
  try {
    const raw = JSON.parse(readFileSync(defaultsFile(), "utf-8"));
    if (raw.model && !raw.modelSlots) {
      raw.modelSlots = { main: raw.model };
      delete raw.model;
    }
    return withOverride({ ...fallback, ...raw });
  } catch {
    return withOverride({ ...fallback });
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
