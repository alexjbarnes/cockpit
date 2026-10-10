"use client";

import { ChevronDown, Keyboard, Minus, Palette, Plus, Settings2, TextCursor, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { type TerminalTheme, useSettings } from "@/hooks/use-settings";
import { cn } from "@/lib/utils";

const RESIZE_PREFIX = "\x01R";
const RESIZE_DEBOUNCE_MS = 150;

const TERMINAL_THEMES: Record<TerminalTheme, { label: string; bg: string; fg: string; cursor: string; selection: string }> = {
  cockpit: {
    label: "Cockpit",
    bg: "#111111",
    fg: "#e8e8e8",
    cursor: "#e8e8e8",
    selection: "rgba(255, 255, 255, 0.15)",
  },
  dark: {
    label: "Dark",
    bg: "#1e1e1e",
    fg: "#d4d4d4",
    cursor: "#aeafad",
    selection: "rgba(86, 156, 214, 0.3)",
  },
  dracula: {
    label: "Dracula",
    bg: "#282a36",
    fg: "#f8f8f2",
    cursor: "#f8f8f2",
    selection: "rgba(68, 71, 90, 0.5)",
  },
  catppuccin: {
    label: "Catppuccin",
    bg: "#1e1e2e",
    fg: "#cdd6f4",
    cursor: "#f5e0dc",
    selection: "rgba(88, 91, 112, 0.4)",
  },
  tokyoNight: {
    label: "Tokyo Night",
    bg: "#1a1b26",
    fg: "#a9b1d6",
    cursor: "#c0caf5",
    selection: "rgba(41, 46, 66, 0.5)",
  },
  nord: {
    label: "Nord",
    bg: "#2e3440",
    fg: "#d8dee9",
    cursor: "#d8dee9",
    selection: "rgba(67, 76, 94, 0.5)",
  },
  gruvbox: {
    label: "Gruvbox",
    bg: "#282828",
    fg: "#ebdbb2",
    cursor: "#ebdbb2",
    selection: "rgba(168, 153, 132, 0.3)",
  },
  solarized: {
    label: "Solarized",
    bg: "#002b36",
    fg: "#839496",
    cursor: "#93a1a1",
    selection: "rgba(38, 139, 210, 0.3)",
  },
  monokai: {
    label: "Monokai",
    bg: "#272822",
    fg: "#f8f8f2",
    cursor: "#f8f8f0",
    selection: "rgba(73, 72, 62, 0.5)",
  },
  oneDark: {
    label: "One Dark",
    bg: "#282c34",
    fg: "#abb2bf",
    cursor: "#528bff",
    selection: "rgba(62, 68, 81, 0.5)",
  },
};

const termInstanceCache = new Map<
  string,
  {
    term: import("@xterm/xterm").Terminal;
    fit: import("@xterm/addon-fit").FitAddon;
    wrapper: HTMLDivElement;
  }
>();

export function disposeTerminalInstance(terminalId: string): void {
  const cached = termInstanceCache.get(terminalId);
  if (cached) {
    cached.term.dispose();
    cached.wrapper.remove();
    termInstanceCache.delete(terminalId);
  }
}

interface TerminalPanelProps {
  terminalId: string;
  cwd: string;
  active?: boolean;
}

const TOOLBAR_KEYS = [
  { label: "Esc", data: "\x1b" },
  { label: "Ctrl", modifier: "ctrl" },
  { label: "Tab", data: "\t" },
  { label: "|", data: "|", separator: true },
  { label: "←", data: "\x1b[D" },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "→", data: "\x1b[C" },
] as const;

/** The keys a phone keyboard does not have, in the four-column shape the
 *  terminal's own expansion opens into: modifiers and editing keys first, then
 *  the punctuation that is otherwise buried behind a symbol page. */
const EXTRA_KEY_ROWS: Array<Array<{ label: string; data?: string; modifier?: "ctrl" | "alt" }>> = [
  [
    { label: "Ctrl", modifier: "ctrl" },
    { label: "Esc", data: "\x1b" },
    { label: "-", data: "-" },
    { label: "/", data: "/" },
  ],
  [
    { label: "←", data: "\x1b[D" },
    { label: "↑", data: "\x1b[A" },
    { label: "↓", data: "\x1b[B" },
    { label: "→", data: "\x1b[C" },
  ],
  [
    { label: "Alt", modifier: "alt" },
    { label: "Tab", data: "\t" },
    { label: "Insert", data: "\x1b[2~" },
    { label: "Delete", data: "\x1b[3~" },
  ],
  [
    { label: "Home", data: "\x1b[H" },
    { label: "Pg Up", data: "\x1b[5~" },
    { label: "Pg Dn", data: "\x1b[6~" },
    { label: "End", data: "\x1b[F" },
  ],
  [
    { label: "|", data: "|" },
    { label: ":", data: ":" },
    { label: ";", data: ";" },
    { label: "!", data: "!" },
  ],
  [
    { label: "~", data: "~" },
    { label: "@", data: "@" },
    { label: "$", data: "$" },
    { label: "*", data: "*" },
  ],
  [
    { label: "^", data: "^" },
    { label: "%", data: "%" },
    { label: "=", data: "=" },
    { label: "`", data: "`" },
  ],
];

/** The terminal's text, newest lines last, as one string — what select mode
 *  hands to the browser so a phone can select and copy it. Capped: the overlay
 *  is a DOM node, and nobody selects their way through 10k lines on a phone. */
function bufferText(term: import("@xterm/xterm").Terminal): string {
  const buffer = term.buffer.active;
  const first = Math.max(0, buffer.length - 2500);
  const lines: string[] = [];
  for (let i = first; i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n").replace(/\s+$/, "");
}

const TERMINAL_FONT_FAMILY = "'Menlo', 'Consolas', 'DejaVu Sans Mono', 'Courier New', 'Symbols Nerd Font Mono', monospace";

/** Clipboard write that also works on the plain-HTTP LAN address, where
 *  navigator.clipboard is undefined. Must run inside the click gesture. */
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function TerminalPanel({ terminalId: initialTerminalId, cwd, active = true }: TerminalPanelProps) {
  const [currentTerminalId, setCurrentTerminalId] = useState(initialTerminalId);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);

  const handleReconnect = useCallback(async () => {
    setReconnecting(true);
    try {
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      if (!res.ok) return;
      const { terminalId } = await res.json();
      setCurrentTerminalId(terminalId);
      setReconnectKey((k) => k + 1);
    } finally {
      setReconnecting(false);
    }
  }, [cwd]);

  return (
    <TerminalPanelInner
      key={`${currentTerminalId}-${reconnectKey}`}
      terminalId={currentTerminalId}
      cwd={cwd}
      active={active}
      onReconnect={handleReconnect}
      reconnecting={reconnecting}
    />
  );
}

interface InnerProps extends TerminalPanelProps {
  onReconnect: () => void;
  reconnecting: boolean;
}

function TerminalPanelInner({ terminalId, cwd: _cwd, active = true, onReconnect, reconnecting }: InnerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ctrlActive, setCtrlActive] = useState(false);
  const ctrlRef = useRef(false);
  const [altActive, setAltActive] = useState(false);
  const altRef = useRef(false);
  // The expanded key panel, and select mode: a phone cannot select a canvas,
  // so the buffer is laid over it as text the browser's own selection can grab.
  const [keysExpanded, setKeysExpanded] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedText, setSelectedText] = useState("");
  const [copied, setCopied] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const isDesktop = useIsDesktop();
  const retryRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const connectedOnceRef = useRef(false);
  const [kbOpen, setKbOpen] = useState(false);
  const fullHeightRef = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { settings, updateSetting } = useSettings();

  useEffect(() => {
    // interactiveWidget is "resizes-content" (see app/layout.tsx), so the soft
    // keyboard shrinks the layout viewport AND visualViewport together. Comparing
    // the two against each other never crosses a threshold; instead track the
    // tallest height seen (keyboard closed) and flag kbOpen when we drop well below it.
    const vv = window.visualViewport;
    const measure = () => (vv ? vv.height : window.innerHeight);
    fullHeightRef.current = Math.max(fullHeightRef.current, measure());
    const handler = () => {
      const h = measure();
      fullHeightRef.current = Math.max(fullHeightRef.current, h);
      setKbOpen(h < fullHeightRef.current * 0.75);
      if (!activeRef.current || !fitRef.current) return;
      fitRef.current.fit();
    };
    const target: EventTarget = vv ?? window;
    target.addEventListener("resize", handler);
    return () => target.removeEventListener("resize", handler);
  }, []);

  useEffect(() => {
    if (active && fitRef.current) {
      fitRef.current.fit();
    }
  }, [active]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const theme = TERMINAL_THEMES[settings.terminalTheme] ?? TERMINAL_THEMES.dark;
    term.options.theme = {
      background: theme.bg,
      foreground: theme.fg,
      cursor: theme.cursor,
      selectionBackground: theme.selection,
    };
    if (containerRef.current) {
      containerRef.current.parentElement!.style.backgroundColor = theme.bg;
    }
  }, [settings.terminalTheme]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = settings.terminalFontSize;
    fitRef.current?.fit();
  }, [settings.terminalFontSize]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.scrollback = settings.terminalScrollback;
  }, [settings.terminalScrollback]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: settings used only for initial values; live updates handled by dedicated effects above
  useEffect(() => {
    let cancelled = false;
    let term: import("@xterm/xterm").Terminal | null = null;
    let fit: import("@xterm/addon-fit").FitAddon | null = null;
    const disposables: Array<{ dispose(): void }> = [];

    async function init() {
      const el = containerRef.current;
      if (!el || cancelled) return;

      const cached = termInstanceCache.get(terminalId);

      if (cached) {
        term = cached.term;
        fit = cached.fit;
        termRef.current = term;
        fitRef.current = fit;
        connectedOnceRef.current = true;
        el.appendChild(cached.wrapper);
        const theme = TERMINAL_THEMES[settings.terminalTheme] ?? TERMINAL_THEMES.dark;
        term.options.theme = { background: theme.bg, foreground: theme.fg, cursor: theme.cursor, selectionBackground: theme.selection };
        term.options.fontSize = settings.terminalFontSize;
        term.options.scrollback = settings.terminalScrollback;
        fit.fit();
      } else {
        const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
        if (cancelled) return;

        const theme = TERMINAL_THEMES[settings.terminalTheme] ?? TERMINAL_THEMES.dark;
        term = new Terminal({
          cursorBlink: true,
          fontSize: settings.terminalFontSize,
          scrollback: settings.terminalScrollback,
          fontFamily: TERMINAL_FONT_FAMILY,
          theme: {
            background: theme.bg,
            foreground: theme.fg,
            cursor: theme.cursor,
            selectionBackground: theme.selection,
          },
        });
        termRef.current = term;

        fit = new FitAddon();
        fitRef.current = fit;
        term.loadAddon(fit);

        const wrapper = document.createElement("div");
        wrapper.style.width = "100%";
        wrapper.style.height = "100%";
        el.appendChild(wrapper);
        term.open(wrapper);
        fit.fit();

        termInstanceCache.set(terminalId, { term, fit, wrapper });
      }

      disposables.push(
        term.onData((data: string) => {
          let payload = data;
          if (ctrlRef.current && data.length === 1) {
            const upper = data.toUpperCase().charCodeAt(0);
            if (upper >= 64 && upper < 96) {
              payload = String.fromCharCode(upper - 64);
              ctrlRef.current = false;
              setCtrlActive(false);
            }
          }
          if (altRef.current && payload.length === 1) {
            payload = `\x1b${payload}`;
            altRef.current = false;
            setAltActive(false);
          }
          sendData(payload);
        }),
      );

      disposables.push(
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
        }),
      );

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
            termInstanceCache.delete(terminalId);
            setError("Terminal disconnected");
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
      for (const d of disposables) d.dispose();
      clearTimeout(retryTimerRef.current);
      clearTimeout(resizeTimerRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
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
    (key: { label: string; data?: string; modifier?: "ctrl" | "alt" }) => {
      if (key.modifier === "ctrl") {
        const next = !ctrlRef.current;
        ctrlRef.current = next;
        setCtrlActive(next);
        return;
      }
      if (key.modifier === "alt") {
        const next = !altRef.current;
        altRef.current = next;
        setAltActive(next);
        return;
      }
      if (key.data !== undefined) {
        sendToTerminal(key.data);
      }
    },
    [sendToTerminal],
  );

  const enterSelectMode = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    setSelectedText(bufferText(term));
    setCopied(false);
    setSelectMode(true);
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedText("");
    setCopied(false);
  }, []);

  const copyFromTerminal = useCallback(async () => {
    // Whatever the user has highlighted, or the whole buffer when they have
    // not: the native long-press menu copies a selection, and this button is
    // the shortcut for the lot.
    const selected = window.getSelection()?.toString() ?? "";
    const ok = await copyText(selected.trim() ? selected : selectedText);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [selectedText]);

  if (error) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <span>{error}</span>
        <button
          type="button"
          onClick={onReconnect}
          disabled={reconnecting}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-muted hover:bg-muted/80 transition-colors disabled:opacity-50"
        >
          {reconnecting ? "Reconnecting..." : "Reconnect"}
        </button>
      </div>
    );
  }

  const currentTheme = TERMINAL_THEMES[settings.terminalTheme] ?? TERMINAL_THEMES.dark;

  return (
    <div className="flex flex-col flex-1 min-h-0" style={{ backgroundColor: currentTheme.bg }}>
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <div ref={containerRef} className="absolute inset-0 px-3 pt-2" />
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="absolute top-2 right-2 z-10 rounded p-1.5 text-white/70 hover:text-white hover:bg-white/10 transition-colors"
        >
          <Settings2 className="h-4.5 w-4.5" />
        </button>
        {selectMode && (
          <div
            className="absolute inset-0 z-20 overflow-auto px-3 pt-2"
            style={{ backgroundColor: currentTheme.bg, color: currentTheme.fg }}
            data-testid="terminal-select-overlay"
          >
            <pre
              className="whitespace-pre-wrap break-words"
              style={{
                fontFamily: TERMINAL_FONT_FAMILY,
                fontSize: settings.terminalFontSize,
                lineHeight: 1.3,
                userSelect: "text",
                WebkitUserSelect: "text",
              }}
            >
              {selectedText}
            </pre>
          </div>
        )}
      </div>
      {!isDesktop && (kbOpen || keysExpanded || selectMode) && (
        <div className="shrink-0 relative z-10 border-t border-border/50" style={{ backgroundColor: currentTheme.bg }}>
          {selectMode ? (
            <div className="flex items-center gap-1.5 px-2 py-1.5" data-testid="terminal-select-bar">
              <div
                role="button"
                tabIndex={-1}
                onPointerDown={(e) => {
                  e.preventDefault();
                  copyFromTerminal();
                }}
                data-testid="terminal-copy"
                className={cn(
                  "flex-1 py-1.5 text-center text-xs font-medium rounded-md transition-colors select-none",
                  copied
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground active:bg-primary active:text-primary-foreground",
                )}
              >
                {copied ? "Copied" : "Copy"}
              </div>
              <div
                role="button"
                tabIndex={-1}
                onPointerDown={(e) => {
                  e.preventDefault();
                  exitSelectMode();
                }}
                data-testid="terminal-select-done"
                className="flex-1 py-1.5 text-center text-xs font-medium rounded-md transition-colors select-none bg-muted text-muted-foreground active:bg-primary active:text-primary-foreground"
              >
                Done
              </div>
            </div>
          ) : (
            <>
              {keysExpanded && (
                <div className="grid grid-cols-4 gap-1.5 px-2 pt-2" data-testid="terminal-key-panel">
                  {EXTRA_KEY_ROWS.flat().map((key) => (
                    <div
                      key={key.label}
                      role="button"
                      tabIndex={-1}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        handleToolbarKey(key);
                      }}
                      className={cn(
                        "py-2 text-center text-xs font-medium rounded-md transition-colors select-none",
                        "active:bg-primary active:text-primary-foreground",
                        key.modifier && (key.modifier === "ctrl" ? ctrlActive : altActive)
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {key.label}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <div
                  role="button"
                  tabIndex={-1}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setKeysExpanded((prev) => !prev);
                  }}
                  aria-label={keysExpanded ? "Fewer keys" : "More keys"}
                  data-testid="terminal-key-panel-toggle"
                  className={cn(
                    "shrink-0 px-2 py-1.5 rounded-md transition-colors select-none",
                    keysExpanded
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground active:bg-primary active:text-primary-foreground",
                  )}
                >
                  {keysExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <Keyboard className="h-3.5 w-3.5" />}
                </div>
                <div className="w-px h-5 bg-border/50 shrink-0" />
                {TOOLBAR_KEYS.map((key) => (
                  <div key={key.label} className="flex min-w-0 flex-1 items-center gap-1.5">
                    {"separator" in key && key.separator && <div className="w-px h-5 bg-border/50 shrink-0" />}
                    <div
                      role="button"
                      tabIndex={-1}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        handleToolbarKey(key);
                      }}
                      className={cn(
                        "min-w-0 flex-1 py-1.5 text-center text-xs font-medium rounded-md transition-colors select-none",
                        "active:bg-primary active:text-primary-foreground",
                        "modifier" in key && key.modifier && ctrlActive
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {key.label}
                    </div>
                  </div>
                ))}
                <div className="w-px h-5 bg-border/50 shrink-0" />
                <div
                  role="button"
                  tabIndex={-1}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    enterSelectMode();
                  }}
                  aria-label="Select and copy"
                  title="Select and copy"
                  data-testid="terminal-select"
                  className="shrink-0 px-2 py-1.5 rounded-md bg-muted text-muted-foreground transition-colors select-none active:bg-primary active:text-primary-foreground"
                >
                  <TextCursor className="h-3.5 w-3.5" />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSettingsOpen(false);
          }}
        >
          <div className="w-full max-w-md mx-4 rounded-lg border bg-background shadow-lg overflow-hidden flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4" />
                <h2 className="text-sm font-semibold">Terminal settings</h2>
              </div>
              <button
                onClick={() => setSettingsOpen(false)}
                className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4 space-y-5 overflow-y-auto">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-foreground">Font size</span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => updateSetting("terminalFontSize", Math.max(1, settings.terminalFontSize - 1))}
                    className="rounded p-1.5 border border-input hover:bg-muted transition-colors"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <span className="text-sm font-mono w-8 text-center">{settings.terminalFontSize}</span>
                  <button
                    onClick={() => updateSetting("terminalFontSize", Math.min(32, settings.terminalFontSize + 1))}
                    className="rounded p-1.5 border border-input hover:bg-muted transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <span className="text-xs font-medium text-foreground">Scrollback lines</span>
                <div className="flex items-center gap-2">
                  {[500, 1000, 5000, 10000].map((n) => (
                    <button
                      key={n}
                      onClick={() => updateSetting("terminalScrollback", n)}
                      className={cn(
                        "rounded-md border px-3 py-1.5 text-xs transition-colors",
                        settings.terminalScrollback === n
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-input hover:bg-muted text-muted-foreground",
                      )}
                    >
                      {n >= 1000 ? `${n / 1000}k` : n}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Palette className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground">Theme</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(Object.entries(TERMINAL_THEMES) as [TerminalTheme, (typeof TERMINAL_THEMES)[TerminalTheme]][]).map(([key, theme]) => (
                    <button
                      key={key}
                      onClick={() => updateSetting("terminalTheme", key)}
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors",
                        settings.terminalTheme === key
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-input hover:bg-muted text-muted-foreground",
                      )}
                    >
                      <div className="h-4 w-4 rounded-sm border border-border/50" style={{ backgroundColor: theme.bg }} />
                      {theme.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
