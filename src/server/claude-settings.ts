import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getClaudeDir, getCockpitCacheDir, getCockpitDir } from "@/server/paths";
import type { SandboxConfig } from "@/types";
import { resolveHookBridgePath } from "./hook-bridge-path";

const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "StopFailure",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "SubagentStart",
  "SubagentStop",
  "Notification",
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
  // Registered for its payload's permission_mode, so the mode the CLI really
  // runs in is known the moment it starts rather than at the first message.
  "SessionStart",
] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

const PERMISSION_HOOK_TIMEOUT_SEC = 86400;

export interface HookSettingsOptions {
  sessionId: string;
  hookUrl: string;
  hookToken: string;
  /** Tools to pre-authorize so PermissionRequest never fires for them. */
  allowList?: string[];
  denyList?: string[];
  /**
   * Per-session thinking state. false writes alwaysThinkingEnabled:false (the
   * CLI's "thinking off"); true forces it on; undefined leaves the user default.
   */
  thinkingEnabled?: boolean;
  /**
   * OS-level Bash sandbox for this session: whether it is on and the domains
   * this session adds. Undefined means off. The shared rules stay in the user's
   * own ~/.claude/settings.json (see buildSessionSandboxBlock).
   */
  sandbox?: SandboxConfig;
}

export interface HookSettingsArtifact {
  /** Absolute path to the settings file. Pass to claude via `--settings <path>`. */
  settingsPath: string;
  /** Env vars to set on the claude spawn so the bridge can authenticate. */
  env: Record<string, string>;
}

/**
 * Build and write the per-session claude settings file. The file lives in
 * `~/.cache/cockpit/hook-settings/<sessionId>.json` (or `$TMPDIR` if HOME
 * is not writable). Call `cleanupHookSettings` on session destroy.
 */
export async function prepareHookSettings(opts: HookSettingsOptions): Promise<HookSettingsArtifact> {
  const bridge = resolveHookBridgePath();
  const base = await loadUserSettings();
  const hooks = buildHooksBlock(bridge);
  const existingHooks = (base.hooks ?? {}) as Record<string, unknown[]>;
  for (const [event, entries] of Object.entries(existingHooks)) {
    if (Array.isArray(entries) && entries.length > 0) {
      if (hooks[event as HookEvent]) {
        hooks[event as HookEvent] = [...entries, ...hooks[event as HookEvent]] as (typeof hooks)[HookEvent];
      }
    }
  }

  const baseAllow = Array.isArray((base.permissions as Record<string, unknown>)?.allow)
    ? (base.permissions as Record<string, string[]>).allow
    : [];
  const baseDeny = Array.isArray((base.permissions as Record<string, unknown>)?.deny)
    ? (base.permissions as Record<string, string[]>).deny
    : [];

  // The user's sandbox block is not copied: the CLI reads it from their own
  // settings file, merges its lists with this file's, and reloads it when it
  // changes. A copy frozen in here at spawn would keep a rule the user has
  // since removed alive until the session restarts.
  const { sandbox: _userSandbox, ...userSettings } = base;

  const settings = {
    ...userSettings,
    hooks,
    permissions: {
      ...((base.permissions as Record<string, unknown>) ?? {}),
      allow: [...baseAllow, ...(opts.allowList ?? [])],
      deny: [...baseDeny, ...(opts.denyList ?? [])],
    },
    // cockpit drives the CLI programmatically and owns the bypass-mode UX
    // itself (flipping bypass on is a deliberate cockpit UI action). The CLI's
    // interactive "WARNING: Bypass Permissions mode" dialog has nowhere to go
    // when there's no human at the TUI, so suppress it here.
    skipDangerousModePermissionPrompt: true,
    // Per-session thinking on/off. cockpit's selector is authoritative, so this
    // overrides any user-global alwaysThinkingEnabled when explicitly provided.
    ...(opts.thinkingEnabled !== undefined ? { alwaysThinkingEnabled: opts.thinkingEnabled } : {}),
    sandbox: buildSessionSandboxBlock(opts.sandbox),
  };

  const dir = await resolveSettingsDir();
  const settingsPath = path.join(dir, `${opts.sessionId}.json`);
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });

  return {
    settingsPath,
    env: {
      COCKPIT_HOOK_URL: opts.hookUrl,
      COCKPIT_HOOK_TOKEN: opts.hookToken,
      COCKPIT_SESSION_ID: opts.sessionId,
    },
  };
}

export async function cleanupHookSettings(sessionId: string): Promise<void> {
  const dir = await resolveSettingsDir();
  const settingsPath = path.join(dir, `${sessionId}.json`);
  await rm(settingsPath, { force: true });
}

function buildHooksBlock(bridgePath: string): Record<HookEvent, Array<{ matcher: string; hooks: Array<HookCommand> }>> {
  const block = {} as Record<HookEvent, Array<{ matcher: string; hooks: Array<HookCommand> }>>;
  for (const event of HOOK_EVENTS) {
    const cmd: HookCommand = {
      type: "command",
      command: `node ${shellQuote(bridgePath)} ${event}`,
    };
    if (event === "PermissionRequest") {
      cmd.timeout = PERMISSION_HOOK_TIMEOUT_SEC;
    }
    block[event] = [{ matcher: "", hooks: [cmd] }];
  }
  return block;
}

interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
}

function shellQuote(p: string): string {
  if (!/[\s"'\\$`]/.test(p)) return p;
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function userSettingsPaths(): string[] {
  return [path.join(getClaudeDir(), "settings.json"), path.join(getClaudeDir(), "settings.local.json")];
}

async function loadUserSettings(): Promise<Record<string, unknown>> {
  let merged: Record<string, unknown> = {};
  for (const p of userSettingsPaths()) {
    try {
      const raw = await readFile(p, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        merged = deepMerge(merged, parsed as Record<string, unknown>);
      }
    } catch {
      // file missing or malformed
    }
  }
  return merged;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const tVal = target[key];
    const sVal = source[key];
    if (isPlainObject(tVal) && isPlainObject(sVal)) {
      result[key] = deepMerge(tVal as Record<string, unknown>, sVal as Record<string, unknown>);
    } else {
      result[key] = sVal;
    }
  }
  return result;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * The sandbox block of a session's own settings file: only what cockpit decides
 * for that session. `enabled` is always written, so the session's toggle decides
 * whether its Bash is sandboxed. The session's domains are its additions; the
 * CLI merges them with the lists in the user's settings. An empty list adds
 * nothing, rather than locking egress to nothing.
 *
 * Cockpit's own directory is fenced from sandboxed reads whether or not this
 * file switches the sandbox on, since another settings source can. It holds the
 * key cockpit signs its login tokens with and the providers' API keys, and a
 * sandboxed command that could read the one and reach cockpit's port could sign
 * itself in and open a terminal outside the sandbox.
 */
function buildSessionSandboxBlock(sandbox: SandboxConfig | undefined): Record<string, unknown> {
  const enabled = sandbox?.enabled === true;
  const block: Record<string, unknown> = { enabled, filesystem: { denyRead: [getCockpitDir()] } };
  if (enabled && sandbox?.allowedDomains?.length) block.network = { allowedDomains: sandbox.allowedDomains };
  return block;
}

let settingsDirCache: string | null = null;

async function resolveSettingsDir(): Promise<string> {
  if (settingsDirCache) return settingsDirCache;
  const primary = path.join(getCockpitCacheDir(), "hook-settings");
  try {
    await mkdir(primary, { recursive: true });
    settingsDirCache = primary;
    return primary;
  } catch {
    const fallback = path.join(tmpdir(), "cockpit-hook-settings");
    await mkdir(fallback, { recursive: true });
    settingsDirCache = fallback;
    return fallback;
  }
}
