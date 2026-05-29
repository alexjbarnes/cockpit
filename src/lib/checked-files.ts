import { useCallback, useSyncExternalStore } from "react";

const store = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
const EMPTY: Set<string> = new Set();

function notify() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getCheckedFiles(cwd: string): Set<string> {
  return store.get(cwd) || EMPTY;
}

export function useCheckedFiles(cwd: string) {
  const checkedFiles = useSyncExternalStore(subscribe, () => store.get(cwd) || EMPTY);

  const toggleFile = useCallback(
    (path: string) => {
      const current = store.get(cwd) || new Set();
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      store.set(cwd, next);
      notify();
    },
    [cwd],
  );

  const toggleAll = useCallback(
    (allPaths: string[]) => {
      const current = store.get(cwd) || new Set();
      store.set(cwd, current.size === allPaths.length ? new Set() : new Set(allPaths));
      notify();
    },
    [cwd],
  );

  const setCheckedFiles = useCallback(
    (files: Set<string>) => {
      store.set(cwd, files);
      notify();
    },
    [cwd],
  );

  return { checkedFiles, toggleFile, toggleAll, setCheckedFiles };
}
