// The Bash sandbox rules in the user's own Claude settings (~/.claude/settings.json).
//
// This is the CLI's global layer, not a cockpit one: every Claude session reads
// it, in cockpit or not, merges its lists with each session's own settings file,
// and reloads it when it changes, so an edit reaches running sessions without a
// restart. Cockpit only reads and writes the fields below and leaves every other
// key in the file, and every other key of its `sandbox` block, as it found them.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getClaudeDir } from "@/server/paths";
import type { SandboxRules } from "@/types";

export function claudeUserSettingsPath(): string {
  return path.join(getClaudeDir(), "settings.json");
}

export const EMPTY_SANDBOX_RULES: SandboxRules = {
  allowedDomains: [],
  deniedDomains: [],
  allowUnixSockets: [],
  allowWrite: [],
  denyWrite: [],
  denyRead: [],
  allowRead: [],
  excludedCommands: [],
};

export interface SandboxRulesFile {
  path: string;
  rules: SandboxRules;
  /** Identifies the file's contents as read, so a save made from a stale read
   *  can be refused instead of overwriting what changed in between. */
  version: string;
  /** The file's own `sandbox.enabled`, which switches the sandbox on for sessions
   *  started outside cockpit. Cockpit sessions follow their own toggle. */
  enabledInFile?: boolean;
}

export class SandboxRulesError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

/** Reads the file. Missing is an empty file; unparseable is an error, because
 *  writing over it would destroy whatever the user had in it. */
async function readSettingsFile(file: string): Promise<{ settings: Json; version: string }> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, version: "" };
    throw new SandboxRulesError(`Could not read ${file}: ${(err as Error).message}`, 409);
  }
  const version = createHash("sha256").update(raw).digest("hex");
  if (raw.trim() === "") return { settings: {}, version };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SandboxRulesError(`${file} is not valid JSON, so cockpit will not rewrite it. Fix or remove it first.`, 409);
  }
  if (!isPlainObject(parsed)) {
    throw new SandboxRulesError(`${file} does not hold a JSON object, so cockpit will not rewrite it.`, 409);
  }
  return { settings: parsed, version };
}

export async function readSandboxRules(): Promise<SandboxRulesFile> {
  const file = claudeUserSettingsPath();
  const { settings, version } = await readSettingsFile(file);
  const sandbox = isPlainObject(settings.sandbox) ? settings.sandbox : {};
  const network = isPlainObject(sandbox.network) ? sandbox.network : {};
  const filesystem = isPlainObject(sandbox.filesystem) ? sandbox.filesystem : {};
  const rules: SandboxRules = {
    allowedDomains: stringList(network.allowedDomains),
    deniedDomains: stringList(network.deniedDomains),
    allowUnixSockets: stringList(network.allowUnixSockets),
    allowWrite: stringList(filesystem.allowWrite),
    denyWrite: stringList(filesystem.denyWrite),
    denyRead: stringList(filesystem.denyRead),
    allowRead: stringList(filesystem.allowRead),
    excludedCommands: stringList(sandbox.excludedCommands),
    ...(typeof network.allowLocalBinding === "boolean" ? { allowLocalBinding: network.allowLocalBinding } : {}),
    ...(typeof sandbox.allowUnsandboxedCommands === "boolean" ? { allowUnsandboxedCommands: sandbox.allowUnsandboxedCommands } : {}),
  };
  return { path: file, rules, version, ...(typeof sandbox.enabled === "boolean" ? { enabledInFile: sandbox.enabled } : {}) };
}

// The CLI's own domain syntax: a hostname (optionally *.-prefixed, needing two
// labels after the star), localhost, an IPv4 literal or a bracketed IPv6
// literal, each with an optional :port. Anything else it refuses, and a refused
// entry is worth catching here rather than in the CLI's settings errors.
const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_PATTERN = new RegExp(`^(?:(?:\\*\\.)?${HOST_LABEL}(?:\\.${HOST_LABEL})+|localhost|\\[[0-9a-f:.]+\\])(?::\\d{1,5})?$`, "i");

export function isValidDomainEntry(entry: string): boolean {
  if (!DOMAIN_PATTERN.test(entry)) return false;
  const port = /:(\d+)$/.exec(entry)?.[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return false;
  // "*.com" is two labels only when counted with the star; the CLI wants a
  // registrable name after it.
  if (entry.startsWith("*.")) return entry.slice(2).split(":")[0].includes(".");
  return true;
}

function cleanList(value: unknown, field: string, validate?: (s: string) => boolean): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new SandboxRulesError(`${field} must be a list of strings`, 400);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value as string[]) {
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    if (/[\0\n\r]/.test(s)) throw new SandboxRulesError(`${field} has an entry with a line break in it`, 400);
    if (validate && !validate(s)) throw new SandboxRulesError(`${field}: "${s}" is not a domain the sandbox accepts`, 400);
    seen.add(s);
    out.push(s);
  }
  return out;
}

function cleanFlag(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new SandboxRulesError(`${field} must be true or false`, 400);
  return value;
}

/** Validates a rules object sent by a client. Missing lists are empty and a
 *  missing flag means "leave it to the CLI's default". */
export function parseSandboxRules(body: unknown): SandboxRules {
  if (!isPlainObject(body)) throw new SandboxRulesError("Expected a rules object", 400);
  const allowLocalBinding = cleanFlag(body.allowLocalBinding, "allowLocalBinding");
  const allowUnsandboxedCommands = cleanFlag(body.allowUnsandboxedCommands, "allowUnsandboxedCommands");
  return {
    allowedDomains: cleanList(body.allowedDomains, "allowedDomains", isValidDomainEntry),
    deniedDomains: cleanList(body.deniedDomains, "deniedDomains", isValidDomainEntry),
    allowUnixSockets: cleanList(body.allowUnixSockets, "allowUnixSockets"),
    allowWrite: cleanList(body.allowWrite, "allowWrite"),
    denyWrite: cleanList(body.denyWrite, "denyWrite"),
    denyRead: cleanList(body.denyRead, "denyRead"),
    allowRead: cleanList(body.allowRead, "allowRead"),
    excludedCommands: cleanList(body.excludedCommands, "excludedCommands"),
    ...(allowLocalBinding !== undefined ? { allowLocalBinding } : {}),
    ...(allowUnsandboxedCommands !== undefined ? { allowUnsandboxedCommands } : {}),
  };
}

/** Sets `key` to `value`, or removes it when the value is empty or unset, so a
 *  cleared rule falls back to the CLI's default instead of an explicit []. */
function put(target: Json, key: string, value: string[] | boolean | undefined): void {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) delete target[key];
  else target[key] = value;
}

/** Applies `rules` to the file's `sandbox` block, keeping everything else in it. */
export function applySandboxRules(settings: Json, rules: SandboxRules): Json {
  const next: Json = { ...settings };
  const sandbox: Json = isPlainObject(settings.sandbox) ? { ...settings.sandbox } : {};
  const network: Json = isPlainObject(sandbox.network) ? { ...sandbox.network } : {};
  const filesystem: Json = isPlainObject(sandbox.filesystem) ? { ...sandbox.filesystem } : {};

  put(network, "allowedDomains", rules.allowedDomains);
  put(network, "deniedDomains", rules.deniedDomains);
  put(network, "allowUnixSockets", rules.allowUnixSockets);
  put(network, "allowLocalBinding", rules.allowLocalBinding);
  put(filesystem, "allowWrite", rules.allowWrite);
  put(filesystem, "denyWrite", rules.denyWrite);
  put(filesystem, "denyRead", rules.denyRead);
  put(filesystem, "allowRead", rules.allowRead);
  put(sandbox, "excludedCommands", rules.excludedCommands);
  put(sandbox, "allowUnsandboxedCommands", rules.allowUnsandboxedCommands);

  if (Object.keys(network).length) sandbox.network = network;
  else delete sandbox.network;
  if (Object.keys(filesystem).length) sandbox.filesystem = filesystem;
  else delete sandbox.filesystem;
  if (Object.keys(sandbox).length) next.sandbox = sandbox;
  else delete next.sandbox;
  return next;
}

/** A settings file's top-level object, or {} when it is missing or unreadable.
 *  For lookups only; writes go through readSettingsFile. */
async function readSettingsLoose(file: string): Promise<Json> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf-8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The CLI's policySettings file, which outranks every other source. */
export function policySettingsPath(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "linux") return "/etc/claude-code/managed-settings.json";
  return null;
}

function sandboxOf(settings: Json): Json {
  return isPlainObject(settings.sandbox) ? settings.sandbox : {};
}

/**
 * Whether a Bash call that sets dangerouslyDisableSandbox would really leave the
 * sandbox, resolved the way the CLI resolves its settings: policySettings
 * decides `enabled` over the session's own file, and the first source in
 * precedence order that sets `allowUnsandboxedCommands` decides that. With the
 * sandbox off the flag changes nothing, and with unsandboxed commands disallowed
 * the CLI ignores it, so in neither case is there an escape to ask about.
 */
export async function sandboxEscapePossible(cwd: string, sessionSandboxEnabled: boolean): Promise<boolean> {
  const policyFile = policySettingsPath();
  const policy = policyFile ? sandboxOf(await readSettingsLoose(policyFile)) : {};
  const enabled = typeof policy.enabled === "boolean" ? policy.enabled : sessionSandboxEnabled;
  if (!enabled) return false;
  const sources = [
    policy,
    sandboxOf(await readSettingsLoose(path.join(cwd, ".claude", "settings.local.json"))),
    sandboxOf(await readSettingsLoose(path.join(cwd, ".claude", "settings.json"))),
    sandboxOf(await readSettingsLoose(claudeUserSettingsPath())),
  ];
  const decided = sources.find((s) => typeof s.allowUnsandboxedCommands === "boolean");
  return decided?.allowUnsandboxedCommands !== false;
}

/**
 * Writes `rules` into the user's settings file. With `baseVersion` (from the read
 * the edit started from), a file that has changed since is refused rather than
 * overwritten: the CLI writes this file too, and a stale save would drop what it
 * added. The write goes to a temp file beside the real one and is renamed over
 * it, so a reader never sees half a file, and a symlinked settings file stays a
 * symlink, with its target rewritten.
 */
export async function writeSandboxRules(rules: SandboxRules, baseVersion?: string): Promise<SandboxRulesFile> {
  const file = claudeUserSettingsPath();
  const { settings, version } = await readSettingsFile(file);
  if (baseVersion !== undefined && baseVersion !== version) {
    throw new SandboxRulesError(
      `${file} has changed since this page loaded it. Reload to see the latest, then make your change again.`,
      409,
    );
  }
  const next = applySandboxRules(settings, rules);
  let target = file;
  try {
    target = await realpath(file);
  } catch {
    // Not there yet: it is created at its own path.
  }
  let mode = 0o644;
  try {
    mode = (await stat(target)).mode & 0o777;
  } catch {
    // new file
  }
  const tmp = `${target}.cockpit-${randomBytes(4).toString("hex")}`;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode });
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw new SandboxRulesError(`Could not write ${file}: ${(err as Error).message}`, 409);
  }
  return readSandboxRules();
}
