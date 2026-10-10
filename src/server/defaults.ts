import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCockpitDir } from "@/server/paths";
import type { ModelSlots, SandboxConfig, SessionPermissionMode, ThinkingLevel } from "@/types";

export type DiffStyle = "split" | "unified";

export interface AppDefaults {
  thinkingLevel: ThinkingLevel;
  /**
   * The permission mode a new session starts in. Replaces the two-state
   * bypassAllPermissions, which an older defaults.json may still hold and
   * getDefaults() reads as bypass or manual. Auto is Anthropic-only, so a
   * session created on another provider's model starts in manual regardless.
   */
  permissionMode: SessionPermissionMode;
  /**
   * The Bash sandbox a new session starts with. Scheduled jobs and the cockpit
   * assistant do not take it, and on a host that cannot enforce a sandbox a
   * session starts without one whatever this says.
   */
  sandbox: SandboxConfig;
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
   * Open the sidebar footer's pages (jobs, inbox, issues, settings) in a modal
   * over the current page instead of navigating away from it. On by default;
   * turning it off restores navigating to the page itself. See
   * src/lib/page-modal.ts.
   */
  modalPagesEnabled: boolean;
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
  permissionMode: "manual",
  sandbox: { enabled: false },
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
  modalPagesEnabled: true,
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

const PERMISSION_MODES: readonly string[] = ["manual", "auto", "bypass"] satisfies SessionPermissionMode[];

function isPermissionMode(v: unknown): v is SessionPermissionMode {
  return typeof v === "string" && PERMISSION_MODES.includes(v);
}

/** Settle the permission-mode default on a raw defaults object: a valid mode
 *  stands, otherwise the legacy boolean decides, otherwise manual. The legacy
 *  key goes either way, so it never outlives the next write. */
function normalisePermissionMode(raw: Record<string, unknown>): void {
  const legacy = raw.bypassAllPermissions;
  delete raw.bypassAllPermissions;
  if (!isPermissionMode(raw.permissionMode)) raw.permissionMode = legacy === true ? "bypass" : fallback.permissionMode;
}

/** A sandbox config as it may be stored or sent: `enabled` must be a boolean,
 *  and the allowlist keeps only non-empty strings, trimmed. Anything else is
 *  not a config, and the caller falls back rather than guessing. */
function parseSandbox(v: unknown): SandboxConfig | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { enabled, allowedDomains } = v as Record<string, unknown>;
  if (typeof enabled !== "boolean") return undefined;
  const domains = Array.isArray(allowedDomains)
    ? allowedDomains
        .filter((d): d is string => typeof d === "string")
        .map((d) => d.trim())
        .filter(Boolean)
    : [];
  return domains.length > 0 ? { enabled, allowedDomains: domains } : { enabled };
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
    normalisePermissionMode(raw);
    raw.sandbox = parseSandbox(raw.sandbox) ?? fallback.sandbox;
    return withOverride({ ...fallback, ...raw });
  } catch {
    return withOverride({ ...fallback });
  }
}

/** `bypassAllPermissions` is accepted for a client still showing the old
 *  toggle, and stored as the mode it meant unless the same write names one. */
export function setDefaults(partial: Partial<AppDefaults> & { bypassAllPermissions?: boolean }): AppDefaults {
  const current = getDefaults();
  const next: Record<string, unknown> = { ...partial };
  if (typeof next.bypassAllPermissions === "boolean" && next.permissionMode === undefined) {
    next.permissionMode = next.bypassAllPermissions ? "bypass" : "manual";
  }
  delete next.bypassAllPermissions;
  // The route hands its body straight through, so an unknown mode is dropped
  // here rather than written and then silently read back as manual.
  if (next.permissionMode !== undefined && !isPermissionMode(next.permissionMode)) delete next.permissionMode;
  if (next.sandbox !== undefined) {
    const sandbox = parseSandbox(next.sandbox);
    if (sandbox) next.sandbox = sandbox;
    else delete next.sandbox;
  }
  const updated = { ...current, ...next } as AppDefaults;
  try {
    mkdirSync(prefsDir(), { recursive: true });
    writeFileSync(defaultsFile(), JSON.stringify(updated, null, 2) + "\n");
  } catch {
    // best effort
  }
  return updated;
}
