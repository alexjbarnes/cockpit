import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeClaudeUserConfig } from "@/server/claude-user-config";
import { debugLog } from "@/server/debug-logger";
import { addInboxMessage } from "@/server/inbox";
import { getClaudeDir, getClaudeUserConfigFile, getCockpitDir } from "@/server/paths";

/**
 * Watches the CLI's user config for the wipe that loses a scheduled job's MCP
 * servers, and puts them back.
 *
 * The CLI treats one unparseable read of ~/.claude.json as corruption: it
 * copies the file into ~/.claude/backups/.claude.json.corrupted.<epoch> and
 * carries on from defaults, whose top-level `mcpServers` is absent. Nothing
 * tells the operator, and the next job that needed gmail or conduit or
 * playwright simply runs without it. Four of these are on disk already, one per
 * reset since 21 September.
 *
 * So cockpit keeps its own record of the servers (and of the two fields a reset
 * rewrites: `numStartups` and `firstStartTime`) and, when the file comes back
 * reset or unreadable, merges them in again and says so in the inbox. The
 * snapshot is refreshed on every healthy check, so a server the user deleted on
 * purpose is not resurrected: only a file that lost servers *and* looks reset
 * counts as a wipe.
 */

export interface ClaudeConfigGuardReport {
  action: "healthy" | "restored" | "broken";
  /** Server names put back. */
  restored: string[];
  /** Server names that were expected but could not be put back. */
  missing: string[];
  /** Where the restored servers were found, when any were. */
  source?: "snapshot" | "backup";
}

interface Snapshot {
  takenAt: number;
  numStartups: number | null;
  firstStartTime: string | null;
  servers: Record<string, unknown>;
}

const snapshotFile = () => path.join(getCockpitDir(), "claude-config-snapshot.json");
const backupsDir = () => path.join(getClaudeDir(), "backups");

function readSnapshot(): Snapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(snapshotFile(), "utf-8")) as Partial<Snapshot>;
    if (!parsed.servers || typeof parsed.servers !== "object") return null;
    return {
      takenAt: parsed.takenAt ?? 0,
      numStartups: typeof parsed.numStartups === "number" ? parsed.numStartups : null,
      firstStartTime: typeof parsed.firstStartTime === "string" ? parsed.firstStartTime : null,
      servers: parsed.servers as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

function writeSnapshot(data: Record<string, unknown>): void {
  const servers = (data.mcpServers ?? {}) as Record<string, unknown>;
  const snapshot: Snapshot = {
    takenAt: Date.now(),
    numStartups: typeof data.numStartups === "number" ? data.numStartups : null,
    firstStartTime: typeof data.firstStartTime === "string" ? data.firstStartTime : null,
    servers,
  };
  try {
    writeFileSync(snapshotFile(), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    debugLog(`[claude-config-guard] snapshot write failed: ${String(err)}`);
  }
}

/** Remember a config cockpit has just written, so the guard reads the change as
 *  the user's (or cockpit's) intent rather than something to undo. */
export function rememberClaudeConfig(data: Record<string, unknown>): void {
  writeSnapshot(data);
}

/** Servers the snapshot knows that `servers` no longer has. */
function lostServers(servers: Record<string, unknown>, snapshot: Snapshot | null): string[] {
  if (!snapshot) return [];
  return Object.keys(snapshot.servers).filter((name) => !(name in servers));
}

/**
 * A reset rewrites the two fields the CLI derives from a fresh file. Neither
 * moves when someone edits the config, so their changing is what separates a
 * wipe from a deliberate deletion.
 */
function looksReset(data: Record<string, unknown>, snapshot: Snapshot | null): boolean {
  if (!snapshot) return false;
  const startups = typeof data.numStartups === "number" ? data.numStartups : null;
  if (startups !== null && snapshot.numStartups !== null && startups < snapshot.numStartups) return true;
  const firstStart = typeof data.firstStartTime === "string" ? data.firstStartTime : null;
  return firstStart !== null && snapshot.firstStartTime !== null && firstStart !== snapshot.firstStartTime;
}

/** The newest backup the CLI left behind that parses, optionally one that still
 *  has servers. It keeps five rotating copies plus each quarantined file. */
function newestBackup(requireServers: boolean): Record<string, unknown> | null {
  let names: string[];
  try {
    names = readdirSync(backupsDir()).filter((n) => n.startsWith(".claude.json."));
  } catch {
    return null;
  }
  const epoch = (name: string) => Number(name.split(".").pop()) || 0;
  for (const name of names.sort((a, b) => epoch(b) - epoch(a))) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(backupsDir(), name), "utf-8")) as Record<string, unknown>;
      const servers = parsed.mcpServers;
      if (requireServers && (!servers || typeof servers !== "object" || Object.keys(servers).length === 0)) continue;
      return parsed;
    } catch {
      /* a quarantined copy is corrupt by definition; try the next one */
    }
  }
  return null;
}

/**
 * Check the user config, restoring the MCP servers when it has been reset.
 * Cheap enough for a timer: it reads one local JSON file and writes only when
 * something is actually wrong.
 */
export function checkClaudeUserConfig(): ClaudeConfigGuardReport {
  const file = getClaudeUserConfigFile();
  const snapshot = readSnapshot();

  let data: Record<string, unknown> | null = null;
  let readable = true;
  try {
    data = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    readable = false;
  }

  if (readable && data) {
    const servers = (data.mcpServers ?? {}) as Record<string, unknown>;
    const lost = lostServers(servers, snapshot);
    if (lost.length === 0 || !looksReset(data, snapshot)) {
      // Healthy, or a change the user made: either way this is the state worth
      // remembering, so an intentional deletion does not come back later.
      writeSnapshot(data);
      return { action: "healthy", restored: [], missing: [] };
    }
    const merged = { ...snapshot!.servers, ...servers };
    const restored = lost.filter((name) => name in merged);
    const next = { ...data, mcpServers: merged };
    const wrote = writeClaudeUserConfig(next);
    const missing = lost.filter((name) => !(name in merged));
    if (!wrote) {
      debugLog("[claude-config-guard] restore write failed");
      return { action: "broken", restored: [], missing: lost };
    }
    writeSnapshot(next);
    notifyRestored(restored, missing, "snapshot");
    return { action: "restored", restored, missing, source: "snapshot" };
  }

  // Unreadable or gone: rebuild from the snapshot, over the newest backup as a
  // base when there is one, since it carries the CLI's own state as well.
  const backup = newestBackup(false);
  const expected = snapshot ? Object.keys(snapshot.servers) : [];
  if (!snapshot && !backup) {
    return { action: "broken", restored: [], missing: expected };
  }
  const base = backup ?? {};
  const backupServers = (base.mcpServers ?? {}) as Record<string, unknown>;
  const merged = { ...backupServers, ...(snapshot?.servers ?? {}) };
  const restored = Object.keys(merged);
  const missing = expected.filter((name) => !(name in merged));
  const next = { ...base, mcpServers: merged };
  if (!writeClaudeUserConfig(next)) {
    debugLog("[claude-config-guard] rebuild write failed");
    return { action: "broken", restored: [], missing: expected };
  }
  writeSnapshot(next);
  const source = snapshot ? "snapshot" : "backup";
  notifyRestored(restored, missing, source);
  return { action: "restored", restored, missing, source };
}

function notifyRestored(restored: string[], missing: string[], source: "snapshot" | "backup"): void {
  const lines = [
    "The CLI's user config (~/.claude.json) came back reset, which is how a run loses the MCP servers it expects.",
    "",
    restored.length > 0
      ? `Put back from cockpit's ${source === "snapshot" ? "snapshot" : "copy of the CLI's own backups"}: ${restored.join(", ")}`
      : "Nothing could be put back.",
    missing.length > 0 ? `Still missing: ${missing.join(", ")}` : "",
  ].filter(Boolean);
  debugLog(`[claude-config-guard] restored ${restored.length} server(s) from ${source}; missing: ${missing.join(", ") || "none"}`);
  try {
    addInboxMessage({
      title: restored.length > 0 ? "MCP servers restored after a ~/.claude.json reset" : "~/.claude.json was reset",
      body: lines.join("\n"),
      priority: missing.length > 0 ? "error" : "warning",
    });
  } catch (err) {
    debugLog(`[claude-config-guard] inbox message failed: ${String(err)}`);
  }
}
