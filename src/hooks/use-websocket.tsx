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

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    clearTimeout(reconnectTimer.current);
    reconnectTimer.current = setTimeout(() => {
      reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
      connectRef.current?.();
    }, reconnectDelay.current);
  }, []);

  const connect = useCallback(async () => {
    if (connectingRef.current || wsRef.current) return;
    connectingRef.current = true;

    let token: string;
    try {
      const res = await fetch("/api/auth/ws-token");
      if (!res.ok) {
        connectingRef.current = false;
        scheduleReconnect();
        return;
      }
      const data = await res.json();
      token = data.token;
    } catch {
      connectingRef.current = false;
      scheduleReconnect();
      return;
    }

    if (wsRef.current || !mountedRef.current) {
      connectingRef.current = false;
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws?token=${token}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;
    connectingRef.current = false;

    ws.onopen = () => {
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

    ws.onclose = () => {
      setConnected(false);
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
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

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;

      // No existing connection - reconnect immediately
      if (!wsRef.current && !connectingRef.current) {
        clearTimeout(reconnectTimer.current);
        reconnectDelay.current = 1000;
        connect();
        return;
      }

      const ws = wsRef.current;
      if (!ws) return;

      // Connection in a transitional state (CONNECTING/CLOSING) - tear down and start fresh
      if (ws.readyState !== WebSocket.OPEN) {
        tearDownAndReconnect();
        return;
      }

      // Connection looks open - probe it with a ping
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
      }, 3000);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(pongTimer.current);
    };
  }, [connect, tearDownAndReconnect]);

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
