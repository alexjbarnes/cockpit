import { type FSWatcher, watch } from "node:fs";

type Listener = () => void;

interface WatchEntry {
  watcher: FSWatcher;
  listeners: Set<Listener>;
}

const watches = new Map<string, WatchEntry>();

const DEBOUNCE_MS = 500;
const IGNORE_RE = /(?:^|[\\/])(?:\.git[\\/](?!HEAD$|refs[\\/])|\.next[\\/]|node_modules[\\/])/;

function startWatch(cwd: string): WatchEntry {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const entry: WatchEntry = {
    watcher: watch(cwd, { recursive: true }, (_event, filename) => {
      if (filename && IGNORE_RE.test(filename)) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        for (const fn of entry.listeners) fn();
      }, DEBOUNCE_MS);
    }),
    listeners: new Set(),
  };

  entry.watcher.on("error", (err) => {
    console.log(`[fs-watcher] error on ${cwd}: ${err.message}`);
    cleanupWatch(cwd);
  });

  return entry;
}

function cleanupWatch(cwd: string): void {
  const entry = watches.get(cwd);
  if (!entry) return;
  entry.watcher.close();
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
