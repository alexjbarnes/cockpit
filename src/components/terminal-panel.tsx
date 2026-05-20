"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { cn } from "@/lib/utils";

const RESIZE_PREFIX = "\x01R";
const RESIZE_DEBOUNCE_MS = 150;

interface TerminalPanelProps {
  terminalId: string;
  cwd: string;
  active?: boolean;
}

const TOOLBAR_KEYS = [
  { label: "Esc", data: "\x1b" },
  { label: "Ctrl", modifier: true },
  { label: "Tab", data: "\t" },
  { label: "|", data: "|", separator: true },
  { label: "←", data: "\x1b[D" },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "→", data: "\x1b[C" },
] as const;

export function TerminalPanel({ terminalId, cwd: _cwd, active = true }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ctrlActive, setCtrlActive] = useState(false);
  const ctrlRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const isDesktop = useIsDesktop();
  const retryRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const connectedOnceRef = useRef(false);
  const [kbOpen, setKbOpen] = useState(false);
  const fullHeightRef = useRef(0);

  useEffect(() => {
    fullHeightRef.current = Math.max(fullHeightRef.current, window.innerHeight);
    const handler = () => {
      fullHeightRef.current = Math.max(fullHeightRef.current, window.innerHeight);
      setKbOpen(window.innerHeight < fullHeightRef.current * 0.75);
      if (!activeRef.current || !fitRef.current) return;
      fitRef.current.fit();
    };
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  useEffect(() => {
    if (active && fitRef.current) {
      fitRef.current.fit();
    }
  }, [active]);

  useEffect(() => {
    let cancelled = false;
    let term: import("@xterm/xterm").Terminal | null = null;
    let fit: import("@xterm/addon-fit").FitAddon | null = null;

    async function init() {
      const el = containerRef.current;
      if (!el || cancelled) return;

      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (cancelled) return;

      term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'Menlo', 'Consolas', 'DejaVu Sans Mono', 'Courier New', 'Symbols Nerd Font Mono', monospace",
        theme: {
          background: "#1e1e1e",
          foreground: "#d4d4d4",
          cursor: "#aeafad",
          selectionBackground: "rgba(86, 156, 214, 0.3)",
        },
      });
      termRef.current = term;

      fit = new FitAddon();
      fitRef.current = fit;
      term.loadAddon(fit);

      term.open(el);
      fit.fit();

      term.onData((data: string) => {
        if (ctrlRef.current && data.length === 1) {
          const upper = data.toUpperCase().charCodeAt(0);
          if (upper >= 64 && upper < 96) {
            sendData(String.fromCharCode(upper - 64));
            ctrlRef.current = false;
            setCtrlActive(false);
            return;
          }
        }
        sendData(data);
      });

      term.onResize(({ cols, rows }) => {
        if (cols < 2 || rows < 2) return;
        if (!activeRef.current) return;
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = setTimeout(() => {
          if (!activeRef.current) return;
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(`${RESIZE_PREFIX}${cols};${rows}`);
          }
        }, RESIZE_DEBOUNCE_MS);
      });

      let touchStartY = 0;
      let scrollAccum = 0;
      const pxPerLine = 8;
      el.addEventListener(
        "touchstart",
        (e) => {
          touchStartY = e.touches[0].clientY;
          scrollAccum = 0;
        },
        { passive: true },
      );
      el.addEventListener(
        "touchmove",
        (e) => {
          const dy = touchStartY - e.touches[0].clientY;
          touchStartY = e.touches[0].clientY;
          scrollAccum += dy;
          const lines = Math.trunc(scrollAccum / pxPerLine);
          if (lines !== 0) {
            scrollAccum -= lines * pxPerLine;
            term?.scrollLines(lines);
          }
        },
        { passive: true },
      );

      connect();
    }

    function sendData(data: string) {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }

    async function connect() {
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }

      try {
        const res = await fetch("/api/auth/ws-token");
        if (!res.ok || cancelled) return;
        const { token } = await res.json();
        if (cancelled) return;

        const replay = connectedOnceRef.current ? "0" : "1";
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${window.location.host}/ws/terminal?token=${token}&terminalId=${terminalId}&replay=${replay}`;
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          retryRef.current = 0;
          setError(null);
          connectedOnceRef.current = true;
          if (term && term.cols > 1 && term.rows > 1) {
            ws.send(`${RESIZE_PREFIX}${term.cols};${term.rows}`);
          }
        };

        ws.onmessage = (event) => {
          term?.write(event.data);
        };

        ws.onclose = (event) => {
          wsRef.current = null;
          if (cancelled) return;

          if (event.code === 1008) {
            setError("Terminal session ended");
            return;
          }

          const delay = Math.min(1000 * 2 ** retryRef.current, 10000);
          retryRef.current++;
          retryTimerRef.current = setTimeout(() => {
            if (!cancelled) connect();
          }, delay);
        };

        ws.onerror = () => {};
      } catch {
        if (cancelled) return;
        const delay = Math.min(1000 * 2 ** retryRef.current, 10000);
        retryRef.current++;
        retryTimerRef.current = setTimeout(() => {
          if (!cancelled) connect();
        }, delay);
      }
    }

    function handleVisibility() {
      if (document.visibilityState === "visible" && !cancelled) {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          clearTimeout(retryTimerRef.current);
          retryRef.current = 0;
          connect();
        }
      }
    }

    init();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      clearTimeout(retryTimerRef.current);
      clearTimeout(resizeTimerRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId]);

  const sendToTerminal = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }, []);

  const handleToolbarKey = useCallback(
    (key: (typeof TOOLBAR_KEYS)[number]) => {
      if ("modifier" in key && key.modifier) {
        const next = !ctrlRef.current;
        ctrlRef.current = next;
        setCtrlActive(next);
        return;
      }
      if ("data" in key) {
        sendToTerminal(key.data);
      }
    },
    [sendToTerminal],
  );

  if (error) {
    return <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-muted-foreground">{error}</div>;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 min-h-0 relative overflow-hidden bg-[#1e1e1e]">
        <div ref={containerRef} className="absolute inset-0 px-3 py-2" />
      </div>
      {!isDesktop && kbOpen && (
        <div className="shrink-0 relative z-10 flex items-center gap-1.5 px-2 py-1.5 border-t border-border/50 bg-[#1e1e1e]">
          {TOOLBAR_KEYS.map((key) => (
            <div key={key.label} className="flex items-center gap-1.5">
              {"separator" in key && key.separator && <div className="w-px h-5 bg-border/50" />}
              <div
                role="button"
                tabIndex={-1}
                onPointerDown={(e) => {
                  e.preventDefault();
                  handleToolbarKey(key);
                }}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-md transition-colors select-none",
                  "active:bg-primary active:text-primary-foreground",
                  "modifier" in key && key.modifier && ctrlActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                )}
              >
                {key.label}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
