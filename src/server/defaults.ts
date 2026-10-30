import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTEXT_SIZES, type ContextSize } from "@/lib/models";
import { getCockpitDir } from "@/server/paths";
import { type ModelSlots, type SandboxConfig, type SessionPermissionMode, THINKING_LEVELS, type ThinkingLevel } from "@/types";

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
   * Raise a banner in the app when a session other than the one on screen
   * wants the user: a finished turn, a question, or a permission prompt. Off
   * by default. Independent of a session's own notification settings — this is
   * about the sessions you are not looking at.
   */
  sessionAlerts: boolean;
  /**
   * Native issue tracker (Issues sidebar icon, /issues pages, Projects
   * settings, the seven issue/project MCP tools). Off by default: it's
   * experimental and gates surfaces across server/MCP/UI — see the MCP tool
   * handlers in cockpit-config-server.ts for the enforcement.
   */
  issuesEnabled: boolean;
  /**
   * Open the sidebar footer's pages (jobs, inbox, issues, insights, settings) in a modal
   * over the current page instead of navigating away from it. On by default;
   * turning it off restores navigating to the page itself. See
   * src/lib/page-modal.ts.
   */
  modalPagesEnabled: boolean;
  /**
   * Record everything Claude Code reports over OpenTelemetry (metrics, events
   * and traces, prompt and tool content included) into cockpit's own
   * telemetry database. Off by default: it is experimental, and it stores the
   * conversation a second time. See src/server/telemetry/.
   */
  telemetryEnabled: boolean;
  /**
   * Opt in to Sonnet 4.6's 1M context window. Off by default because it needs
   * usage credits (claude.ai/settings/usage) and silently runs at 200K without
   * them. When on, cockpit requests 1M for Sonnet 4.6 and surfaces the credits
   * error if it's not actually enabled. Other models' 1M is unaffected.
   */
  allowSonnet1m: boolean;
  /**
   * Offer the deprecated Stream (headless) runtime in the new-session dialog,
   * the composer's Harness tab and the job editor. Off by default. A
   * presentation gate only: an existing Stream session or job keeps running,
   * and the API keeps accepting `runtime: "stream"` either way.
   */
  streamRuntimeEnabled: boolean;
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
  sessionAlerts: false,
  issuesEnabled: false,
  modalPagesEnabled: true,
  telemetryEnabled: false,
  allowSonnet1m: false,
  streamRuntimeEnabled: false,
};

/**
 * Env overrides for experimental switches, so a dev run can start with one on
 * without flipping its Settings toggle. They apply only when reading, never
 * reach defaults.json, and so never outlive the run that set them. Unset (the
 * normal case) changes nothing; a value other than the four recognised below
 * is ignored rather than guessed at.
 */
const ENV_OVERRIDES = {
  issuesEnabled: "COCKPIT_ISSUES_ENABLED",
  telemetryEnabled: "COCKPIT_TELEMETRY_ENABLED",
} as const satisfies Partial<Record<keyof AppDefaults, string>>;

function envOverride(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return undefined;
}

function applyEnvOverrides(d: AppDefaults): AppDefaults {
  const out = { ...d };
  for (const [key, name] of Object.entries(ENV_OVERRIDES) as [keyof typeof ENV_OVERRIDES, string][]) {
    const value = envOverride(name);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const PERMISSION_MODES: readonly string[] = ["manual", "auto", "bypass"] satisfies SessionPermissionMode[];

export function isPermissionMode(v: unknown): v is SessionPermissionMode {
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

/** A model slot set as it may be stored or sent. `main` is any model a session
 *  can run, Anthropic's or a provider's (qualified `provider:model`), so it is
 *  only checked for being a non-empty string; the context size and the other
 *  slots are kept when they are of the right shape and dropped otherwise. */
function parseModelSlots(v: unknown): ModelSlots | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { main, mainContext, subagent, fast } = v as Record<string, unknown>;
  if (typeof main !== "string" || !main.trim()) return undefined;
  const slots: ModelSlots = { main: main.trim() };
  if (typeof mainContext === "string" && mainContext in CONTEXT_SIZES) slots.mainContext = mainContext as ContextSize;
  if (typeof subagent === "string" && subagent.trim()) slots.subagent = subagent.trim();
  if (typeof fast === "string" && fast.trim()) slots.fast = fast.trim();
  return slots;
}

/** A sandbox config as it may be stored or sent: `enabled` must be a boolean,
 *  and the allowlist keeps only non-empty strings, trimmed. Anything else is
 *  not a config, and the caller falls back rather than guessing. */
export function parseSandbox(v: unknown): SandboxConfig | undefined {
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

/** The defaults as stored, without the env overrides. */
function readStoredDefaults(): AppDefaults {
  try {
    const raw = JSON.parse(readFileSync(defaultsFile(), "utf-8"));
    if (raw.model && !raw.modelSlots) {
      raw.modelSlots = { main: raw.model };
      delete raw.model;
    }
    normalisePermissionMode(raw);
    raw.sandbox = parseSandbox(raw.sandbox) ?? fallback.sandbox;
    return { ...fallback, ...raw };
  } catch {
    return { ...fallback };
  }
}

export function getDefaults(): AppDefaults {
  return applyEnvOverrides(readStoredDefaults());
}

/** `bypassAllPermissions` is accepted for a client still showing the old
 *  toggle, and stored as the mode it meant unless the same write names one.
 *  Built on the stored values, so an env override in force is not written
 *  back; what it returns is what reads will see, overrides included. */
export function setDefaults(partial: Partial<AppDefaults> & { bypassAllPermissions?: boolean }): AppDefaults {
  const current = readStoredDefaults();
  const next: Record<string, unknown> = { ...partial };
  if (typeof next.bypassAllPermissions === "boolean" && next.permissionMode === undefined) {
    next.permissionMode = next.bypassAllPermissions ? "bypass" : "manual";
  }
  delete next.bypassAllPermissions;
  // The route hands its body straight through, so an unknown mode is dropped
  // here rather than written and then silently read back as manual.
  if (next.permissionMode !== undefined && !isPermissionMode(next.permissionMode)) delete next.permissionMode;
  if (next.modelSlots !== undefined) {
    const slots = parseModelSlots(next.modelSlots);
    if (slots) next.modelSlots = slots;
    else delete next.modelSlots;
  }
  if (next.thinkingLevel !== undefined && !(THINKING_LEVELS as readonly string[]).includes(next.thinkingLevel as string)) {
    delete next.thinkingLevel;
  }
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
  return applyEnvOverrides(updated);
}
