import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getClaudeBin } from "@/server/claude-bin";

const execFileAsync = promisify(execFile);

// Marketplace refresh and `install`/`update` shell out to git, which can be slow
// on a cold cache. Read commands are sub-second, but share the same ceiling.
const PLUGIN_CMD_TIMEOUT_MS = 120_000;
// The `--available` catalog JSON is ~110KB today (200+ plugins); leave headroom.
const PLUGIN_CMD_MAX_BUFFER = 32 * 1024 * 1024;

export type PluginScope = "user" | "project" | "local";

const PLUGIN_SCOPES = new Set<PluginScope>(["user", "project", "local"]);
/** Narrow an arbitrary string to a PluginScope, or undefined to let the CLI decide. */
export function coercePluginScope(value: string | null | undefined): PluginScope | undefined {
  return value && PLUGIN_SCOPES.has(value as PluginScope) ? (value as PluginScope) : undefined;
}

export interface InstalledPlugin {
  /** "name@marketplace" */
  id: string;
  version: string;
  scope: PluginScope;
  enabled: boolean;
  installPath: string;
  installedAt?: string;
  lastUpdated?: string;
  mcpServers?: Record<string, unknown>;
}

export interface AvailablePlugin {
  /** "name@marketplace" */
  pluginId: string;
  name: string;
  description?: string;
  marketplaceName: string;
  source?: unknown;
  installCount?: number;
}

export interface Marketplace {
  name: string;
  source: string;
  repo?: string;
  installLocation: string;
}

export interface PluginCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run `claude plugin <args...>` non-interactively and capture its output.
 * Never throws on a non-zero exit -- the caller inspects `ok` and `stderr` so
 * CLI errors surface to the UI instead of crashing the route.
 */
export async function runClaudePlugin(args: string[]): Promise<PluginCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(getClaudeBin(), ["plugin", ...args], {
      encoding: "utf-8",
      timeout: PLUGIN_CMD_TIMEOUT_MS,
      maxBuffer: PLUGIN_CMD_MAX_BUFFER,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr || e.message || "plugin command failed" };
  }
}

/** Installed plugins plus the full marketplace catalog, in one CLI call. */
export async function listPlugins(): Promise<{ installed: InstalledPlugin[]; available: AvailablePlugin[] }> {
  const res = await runClaudePlugin(["list", "--available", "--json"]);
  if (!res.ok) throw new Error(res.stderr);
  const parsed = JSON.parse(res.stdout) as { installed?: InstalledPlugin[]; available?: AvailablePlugin[] };
  return { installed: parsed.installed ?? [], available: parsed.available ?? [] };
}

export async function listMarketplaces(): Promise<Marketplace[]> {
  const res = await runClaudePlugin(["marketplace", "list", "--json"]);
  if (!res.ok) throw new Error(res.stderr);
  return JSON.parse(res.stdout) as Marketplace[];
}

/** Enable or disable an installed plugin. Scope defaults to the CLI's auto-detect. */
export async function setPluginEnabled(id: string, enabled: boolean, scope?: PluginScope): Promise<PluginCommandResult> {
  const args = [enabled ? "enable" : "disable", id];
  if (scope) args.push("-s", scope);
  return runClaudePlugin(args);
}

/** Uninstall a plugin. `-y` is required because cockpit runs the CLI without a TTY. */
export async function uninstallPlugin(id: string, scope?: PluginScope): Promise<PluginCommandResult> {
  const args = ["uninstall", id, "-y"];
  if (scope) args.push("-s", scope);
  return runClaudePlugin(args);
}

/** Install a plugin (id is "name@marketplace"). Clones from the marketplace source, so it can be slow. */
export async function installPlugin(id: string, scope: PluginScope = "user"): Promise<PluginCommandResult> {
  return runClaudePlugin(["install", id, "-s", scope]);
}

/** Update an installed plugin from its marketplace source. Runs git pull on the plugin's source. */
export async function updatePlugin(id: string): Promise<PluginCommandResult> {
  return runClaudePlugin(["update", id]);
}

/** Add a marketplace from a URL, path, or GitHub repo. Clones from the source, so it can be slow. Scope defaults to user. */
export async function addMarketplace(source: string, scope?: PluginScope): Promise<PluginCommandResult> {
  const args = ["marketplace", "add", source];
  if (scope) args.push("--scope", scope);
  return runClaudePlugin(args);
}

/** Remove a configured marketplace. Omitting scope removes its declaration from every settings scope. */
export async function removeMarketplace(name: string, scope?: PluginScope): Promise<PluginCommandResult> {
  const args = ["marketplace", "remove", name];
  if (scope) args.push("--scope", scope);
  return runClaudePlugin(args);
}

/** Update one marketplace from its source, or all when name is omitted. Hits git, so it can be slow. */
export async function updateMarketplace(name?: string): Promise<PluginCommandResult> {
  const args = ["marketplace", "update"];
  if (name) args.push(name);
  return runClaudePlugin(args);
}
