import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { debugLog } from "@/server/debug-logger";
import { getClaudeUserConfigFile } from "@/server/paths";

/**
 * Reading and writing the CLI's user config (~/.claude.json), the one file both
 * the CLI and cockpit own.
 *
 * Two hazards shaped this module.
 *
 * The file can be its own mount. This project's dev container bind-mounts the
 * host's copy, and rename onto a mount point fails EBUSY, so the atomic path is
 * unavailable exactly where several writers run at once: the host's CLI, this
 * container's CLI and cockpit. The CLI's own lock does not help, since it locks
 * `<config path>.lock` and that path names a different file on each side of the
 * mount.
 *
 * A reader that catches a half-written file is not merely shown stale data. The
 * CLI treats one unparseable read of this file as corruption: it copies it to
 * ~/.claude/backups/.claude.json.corrupted.<epoch> and continues from defaults,
 * which is how a wipe loses every MCP server a scheduled job depends on.
 *
 * So the in-place fallback here never truncates. A document shorter than the one
 * already in the file is padded with spaces, which JSON accepts, so the file
 * keeps its length and a reader never finds either an empty file or a valid
 * document followed by the tail of a longer one. Those were the two shapes that
 * made the CLI reset itself.
 */

/** The path as the CLI would reach it, through symlinks where they exist. A
 *  symlinked config keeps the CLI's own atomic write (it resolves symlinks
 *  before writing) and must do the same for ours. */
export function resolveClaudeUserConfigPath(): string {
  const file = getClaudeUserConfigFile();
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/** The parsed config, or null when it is missing or unparseable. Never throws. */
export function readClaudeUserConfig(): { path: string; data: Record<string, unknown> } | null {
  try {
    const file = getClaudeUserConfigFile();
    return { path: file, data: JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Read, apply, write. Returns false when the file cannot be read, so a broken
 * document is never replaced with a merge of whatever a failed parse left.
 * An updater that returns false means "no change", and the file is left alone
 * rather than rewritten byte for byte.
 *
 * `create` is for callers whose write *is* the user asking for something (saving
 * an MCP server): with no file yet there is nothing to lose and one gets made.
 * Without it a missing file is left missing, since a config the CLI has never
 * written is not cockpit's to invent.
 */
export function updateClaudeUserConfig(
  update: (data: Record<string, unknown>) => boolean | undefined,
  opts?: { create?: boolean },
): boolean {
  const read = readClaudeUserConfig();
  if (!read) {
    // Present but unreadable is left exactly as it is: a partial merge written
    // over it is how a recoverable document is lost.
    if (existsSync(getClaudeUserConfigFile()) || !opts?.create) return false;
    const fresh: Record<string, unknown> = {};
    const changed = update(fresh);
    if (changed === false) return false;
    return writeClaudeUserConfig(fresh);
  }
  const changed = update(read.data);
  if (changed === false) return false;
  return writeClaudeUserConfig(read.data);
}

/** Replace the config with `data`, atomically where the filesystem allows it. */
export function writeClaudeUserConfig(data: unknown): boolean {
  const file = resolveClaudeUserConfigPath();
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${file}.cockpit-tmp-${process.pid}`;

  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
  }

  // Rename is unavailable (EBUSY when the config path is its own mount). Write
  // in place without truncating: the new document first, then spaces over
  // whatever of the old one is left, so the file's length and validity are both
  // preserved for a reader arriving mid-write.
  try {
    const previous = statSync(file).size;
    const bytes = Buffer.byteLength(text);
    const fd = openSync(file, "r+");
    try {
      writeSync(fd, text, 0, "utf8");
      if (previous > bytes) {
        writeSync(fd, " ".repeat(previous - bytes), bytes, "utf8");
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // No file yet: there is nothing to preserve, so a plain create is safe.
      try {
        writeFileSync(file, text, { mode: 0o600 });
        return true;
      } catch (createErr) {
        debugLog(`[claude-config] create failed: ${String(createErr)}`);
        return false;
      }
    }
    debugLog(`[claude-config] in-place write failed: ${String(err)}`);
    return false;
  }
}
