"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import type { ClientMessage, ServerMessage } from "@/types";

type MessageHandler = (msg: ServerMessage) => void;

interface WebSocketContextValue {
  connected: boolean;
  send: (msg: ClientMessage) => void;
  subscribe: (handler: MessageHandler) => () => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<MessageHandler>>(new Set());
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reconnectDelay = useRef(1000);
  const queueRef = useRef<ClientMessage[]>([]);
  const connectingRef = useRef(false);
  const mountedRef = useRef(true);

  const connectRef = useRef<() => void>(undefined);
  const pongTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const awaitingPong = useRef(false);
  const healthTimer = useRef<ReturnType<typeof setInterval>>(undefined);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    clearTimeout(reconnectTimer.current);
    // Cap backoff at 5s when page is visible, 30s when hidden
    const maxDelay = document.visibilityState === "visible" ? 5000 : 30000;
    const delay = Math.min(reconnectDelay.current, maxDelay);
    console.log(`[ws] reconnect scheduled in ${delay}ms`);
    reconnectTimer.current = setTimeout(() => {
      reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
      connectRef.current?.();
    }, delay);
  }, []);

  const connect = useCallback(async () => {
    if (connectingRef.current || wsRef.current) {
      console.log(`[ws] connect skipped (connecting=${connectingRef.current}, hasWs=${!!wsRef.current})`);
      return;
    }
    connectingRef.current = true;
    console.log("[ws] connecting...");

    let token: string;
    try {
      const res = await fetch("/api/auth/ws-token");
      if (!res.ok) {
        console.warn(`[ws] ws-token fetch failed (${res.status})`);
        connectingRef.current = false;
        scheduleReconnect();
        return;
      }
      const data = await res.json();
      token = data.token;
    } catch (err) {
      console.warn("[ws] ws-token fetch error:", err);
      connectingRef.current = false;
      scheduleReconnect();
      return;
    }

    if (wsRef.current || !mountedRef.current) {
      console.log(`[ws] connect aborted (hasWs=${!!wsRef.current}, mounted=${mountedRef.current})`);
      connectingRef.current = false;
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws?token=${token}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;
    connectingRef.current = false;

    ws.onopen = () => {
      console.log("[ws] connected");
      setConnected(true);
      reconnectDelay.current = 1000;
      for (const queued of queueRef.current) {
        ws.send(JSON.stringify(queued));
      }
      queueRef.current = [];
    };

    ws.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data);
      if (msg.type === "pong") {
        clearTimeout(pongTimer.current);
        awaitingPong.current = false;
      }
      for (const handler of handlersRef.current) {
        handler(msg);
      }
    };

    ws.onclose = (event) => {
      console.log(`[ws] closed (code=${event.code}), scheduling reconnect`);
      setConnected(false);
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      // Always reset delay on close so reconnection is fast
      reconnectDelay.current = 1000;
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [scheduleReconnect]);

  connectRef.current = connect;

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimer.current);
      clearInterval(healthTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      connectingRef.current = false;
    };
  }, [connect]);

  const tearDownAndReconnect = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      wsRef.current = null;
    }
    setConnected(false);
    reconnectDelay.current = 1000;
    connectRef.current?.();
  }, []);

  // Periodic health check: while page is visible, verify connection every 10s.
  // Mobile browsers aggressively kill WebSockets even for visible pages.
  useEffect(() => {
    const startHealthCheck = () => {
      clearInterval(healthTimer.current);
      if (document.visibilityState !== "visible") return;

      healthTimer.current = setInterval(() => {
        // No connection and not connecting - reconnect now
        if (!wsRef.current && !connectingRef.current) {
          console.log("[ws] health: no connection, forcing reconnect");
          clearTimeout(reconnectTimer.current);
          reconnectDelay.current = 1000;
          connectRef.current?.();
          return;
        }

        const ws = wsRef.current;
        if (!ws) return;

        // Dead connection - tear down
        if (ws.readyState !== WebSocket.OPEN) {
          console.log(`[ws] health: dead connection (readyState=${ws.readyState}), tearing down`);
          tearDownAndReconnect();
          return;
        }

        // Probe with ping
        if (awaitingPong.current) return;
        awaitingPong.current = true;
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          awaitingPong.current = false;
          tearDownAndReconnect();
          return;
        }

        clearTimeout(pongTimer.current);
        pongTimer.current = setTimeout(() => {
          awaitingPong.current = false;
          tearDownAndReconnect();
        }, 10000);
      }, 10000);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        console.log(`[ws] page visible (hasWs=${!!wsRef.current}, connecting=${connectingRef.current})`);
        startHealthCheck();

        // Immediate check on becoming visible
        if (!wsRef.current && !connectingRef.current) {
          console.log("[ws] no connection on visibility, reconnecting now");
          clearTimeout(reconnectTimer.current);
          reconnectDelay.current = 1000;
          connectRef.current?.();
          return;
        }

        const ws = wsRef.current;
        if (!ws) return;

        if (ws.readyState !== WebSocket.OPEN) {
          tearDownAndReconnect();
          return;
        }

        if (awaitingPong.current) return;
        awaitingPong.current = true;
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          awaitingPong.current = false;
          tearDownAndReconnect();
          return;
        }

        clearTimeout(pongTimer.current);
        pongTimer.current = setTimeout(() => {
          awaitingPong.current = false;
          tearDownAndReconnect();
        }, 10000);
      } else {
        clearInterval(healthTimer.current);
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    startHealthCheck();

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearInterval(healthTimer.current);
      clearTimeout(pongTimer.current);
    };
  }, [tearDownAndReconnect]);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    } else {
      queueRef.current.push(msg);
    }
  }, []);

  const subscribe = useCallback((handler: MessageHandler) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  return (
    <WebSocketContext.Provider value={{ connected, send, subscribe }}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket(): WebSocketContextValue {
  const ctx = useContext(WebSocketContext);
  if (!ctx) throw new Error("useWebSocket must be used within WebSocketProvider");
  return ctx;
}
