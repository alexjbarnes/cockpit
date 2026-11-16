"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useWebSocket } from "@/hooks/use-websocket";

interface WatchContextValue {
  register: (key: string, ids: readonly string[]) => void;
  unregister: (key: string) => void;
}

const WatchContext = createContext<WatchContextValue | null>(null);

/**
 * One `session:subscribe` sender for the page. The server replaces everything
 * it watches for a connection whenever a subscribe arrives, so two components
 * sending their own lists would wipe each other's: each group of ids (the
 * sidebar's sessions, the assistant) registers here instead, and the union is
 * sent when it changes and again after a reconnect.
 */
export function SessionWatchProvider({ children }: { children: ReactNode }) {
  const { send, connected } = useWebSocket();
  const groups = useRef(new Map<string, readonly string[]>());
  const [joined, setJoined] = useState("");

  const publish = useCallback(() => {
    const all = new Set<string>();
    for (const ids of groups.current.values()) for (const id of ids) all.add(id);
    // Sorted and joined so the same set in another order does not re-send.
    setJoined([...all].sort().join(","));
  }, []);

  const register = useCallback(
    (key: string, ids: readonly string[]) => {
      groups.current.set(key, ids);
      publish();
    },
    [publish],
  );

  const unregister = useCallback(
    (key: string) => {
      groups.current.delete(key);
      publish();
    },
    [publish],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: connected re-sends after a reconnect, which drops the server's per-connection watches
  useEffect(() => {
    if (!joined) return;
    send({ type: "session:subscribe", sessionIds: joined.split(",") });
  }, [joined, connected, send]);

  return <WatchContext.Provider value={{ register, unregister }}>{children}</WatchContext.Provider>;
}

/** Register a group of sessions to watch while this component is mounted. */
export function useSessionWatch(key: string, ids: readonly string[]): void {
  const ctx = useContext(WatchContext);
  const joined = ids.join(",");
  useEffect(() => {
    if (!ctx) return;
    ctx.register(key, joined ? joined.split(",") : []);
    return () => ctx.unregister(key);
  }, [ctx, key, joined]);
}
