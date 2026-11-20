import { type FSWatcher, watch } from "node:fs";
import path from "node:path";

type Listener = () => void;

interface WatchEntry {
  watcher: FSWatcher | null;
  listeners: Set<Listener>;
  timer: ReturnType<typeof setTimeout> | null;
  retry: ReturnType<typeof setTimeout> | null;
  delay: number;
  closed: boolean;
}

const watches = new Map<string, WatchEntry>();

const DEBOUNCE_MS = 500;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** The page sends the folders it has expanded. That is normally a handful,
 *  but an input that is never bounded is not a safe input. */
const MAX_DIRECTORIES = 2_000;

/**
 * Watch one directory, without descending into it.
 *
 * A recursive watch is not native on Linux: Node walks the whole tree on the
 * main thread and adds an inotify watch for every entry, which makes a session
 * in a large folder (a monorepo, a virtualenv, node_modules) block the server.
 * The page only needs live updates for the folders it has open, so it sends
 * those and each is watched directly; a directory is cheap, a tree is not.
 *
 * An error re-arms the watcher with backoff, since a page stays subscribed
 * while its watch is briefly unavailable. A directory that no longer exists is
 * not retried: the page's next expansion change sends a fresh list.
 */
function arm(dir: string, entry: WatchEntry): void {
  if (entry.closed) return;
  try {
    entry.watcher = watch(dir, { recursive: false }, () => {
      if (entry.timer) return;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        for (const fn of entry.listeners) fn();
      }, DEBOUNCE_MS);
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return;
    console.log(`[dir-watcher] cannot watch ${dir}: ${(err as Error).message}; retrying in ${entry.delay}ms`);
    scheduleRetry(dir, entry);
    return;
  }
  entry.delay = RETRY_MIN_MS;
  entry.watcher.on("error", (err) => {
    console.log(`[dir-watcher] error on ${dir}: ${err.message}; re-arming in ${entry.delay}ms`);
    entry.watcher?.close();
    entry.watcher = null;
    scheduleRetry(dir, entry);
  });
}

function scheduleRetry(dir: string, entry: WatchEntry): void {
  if (entry.retry || entry.closed) return;
  entry.retry = setTimeout(() => {
    entry.retry = null;
    arm(dir, entry);
  }, entry.delay);
  entry.delay = Math.min(entry.delay * 2, RETRY_MAX_MS);
}

function watchDirectory(dir: string, listener: Listener): () => void {
  let entry = watches.get(dir);
  if (!entry) {
    entry = { watcher: null, listeners: new Set(), timer: null, retry: null, delay: RETRY_MIN_MS, closed: false };
    watches.set(dir, entry);
    arm(dir, entry);
  }
  entry.listeners.add(listener);
  const held = entry;

  return () => {
    held.listeners.delete(listener);
    if (held.listeners.size > 0) return;
    held.closed = true;
    if (held.timer) clearTimeout(held.timer);
    if (held.retry) clearTimeout(held.retry);
    held.watcher?.close();
    watches.delete(dir);
  };
}

/**
 * Watch `dirs` (relative to `cwd`, with "" for the folder itself), calling
 * `listener` when any of them changes. Paths outside `cwd` are ignored, as is
 * anything beyond the directory cap. The returned function removes this
 * caller's watches.
 */
export function watchDirectories(cwd: string, dirs: readonly string[], listener: Listener): () => void {
  const root = path.resolve(cwd);
  const seen = new Set<string>();
  const cleanups: Array<() => void> = [];

  for (const rel of dirs) {
    if (cleanups.length >= MAX_DIRECTORIES) {
      console.log(`[dir-watcher] ${root}: watching the first ${MAX_DIRECTORIES} folders; the rest are not watched`);
      break;
    }
    const resolved = path.resolve(root, rel || ".");
    if (resolved !== root && !resolved.startsWith(root + path.sep)) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    cleanups.push(watchDirectory(resolved, listener));
  }

  return () => {
    for (const fn of cleanups) fn();
  };
}
