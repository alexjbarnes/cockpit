import { type FSWatcher, watch } from "node:fs";

type Listener = () => void;

interface WatchEntry {
  watcher: FSWatcher | null;
  listeners: Set<Listener>;
  /** Set while a watcher is being re-created after an error. */
  retry: ReturnType<typeof setTimeout> | null;
}

const watches = new Map<string, WatchEntry>();

const DEBOUNCE_MS = 500;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const IGNORE_RE = /(?:^|[\\/])(?:\.git[\\/](?!HEAD$|refs[\\/])|\.next[\\/]|node_modules[\\/])/;

/**
 * Watch `cwd` recursively, and keep watching it.
 *
 * A watcher can fail after it was created (an inotify error, a mount going
 * away), and the old code dropped it while the listeners stayed registered: the
 * page kept its subscription and simply stopped hearing about changes until it
 * reloaded and subscribed again. An error now re-arms the watcher, backing off
 * to half a minute, and a synchronous failure to create one retries the same
 * way. A directory that no longer exists is not retried: nothing will appear in
 * it.
 */
function startWatch(cwd: string): WatchEntry {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = RETRY_MIN_MS;

  const entry: WatchEntry = { watcher: null, listeners: new Set(), retry: null };

  const scheduleRetry = () => {
    entry.retry = setTimeout(() => arm(false), delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  };

  // `first` is the attempt watchCwd makes itself, before it has added its
  // listener; a retry only matters while something is still listening.
  const arm = (first: boolean) => {
    entry.retry = null;
    if (!first && entry.listeners.size === 0) return;
    try {
      entry.watcher = watch(cwd, { recursive: true }, (_event, filename) => {
        if (filename && IGNORE_RE.test(filename)) return;
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          for (const fn of entry.listeners) fn();
        }, DEBOUNCE_MS);
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return;
      console.log(`[fs-watcher] cannot watch ${cwd}: ${(err as Error).message}; retrying in ${delay}ms`);
      scheduleRetry();
      return;
    }
    delay = RETRY_MIN_MS;
    entry.watcher.on("error", (err) => {
      console.log(`[fs-watcher] error on ${cwd}: ${err.message}; re-arming in ${delay}ms`);
      entry.watcher?.close();
      entry.watcher = null;
      scheduleRetry();
    });
  };

  arm(true);
  return entry;
}

function cleanupWatch(cwd: string): void {
  const entry = watches.get(cwd);
  if (!entry) return;
  if (entry.retry) clearTimeout(entry.retry);
  entry.watcher?.close();
  watches.delete(cwd);
}

export function watchCwd(cwd: string, listener: Listener): () => void {
  let entry = watches.get(cwd);
  if (!entry) {
    entry = startWatch(cwd);
    watches.set(cwd, entry);
  }
  entry.listeners.add(listener);

  return () => {
    entry!.listeners.delete(listener);
    if (entry!.listeners.size === 0) {
      cleanupWatch(cwd);
    }
  };
}
