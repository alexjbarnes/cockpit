import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { resolveHookBridgePath } from "./hook-bridge-path";

const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit", "Notification", "PermissionRequest"] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

const PERMISSION_HOOK_TIMEOUT_SEC = 86400;

export interface HookSettingsOptions {
  sessionId: string;
  hookUrl: string;
  hookToken: string;
  /** Tools to pre-authorize so PermissionRequest never fires for them. */
  allowList?: string[];
  denyList?: string[];
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
  const settings = {
    hooks: buildHooksBlock(bridge),
    permissions: {
      allow: opts.allowList ?? [],
      deny: opts.denyList ?? [],
    },
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

let settingsDirCache: string | null = null;

async function resolveSettingsDir(): Promise<string> {
  if (settingsDirCache) return settingsDirCache;
  const primary = path.join(homedir(), ".cache", "cockpit", "hook-settings");
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
