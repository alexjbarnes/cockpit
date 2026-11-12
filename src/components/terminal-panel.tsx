"use client";

import type { Terminal as GhosttyTerminal } from "ghostty-web";
import { ChevronDown, Keyboard, Minus, Palette, Plus, Settings2, TextCursor, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { type TerminalTheme, useSettings } from "@/hooks/use-settings";
import { DA1_RESPONSE, isDa1Response, takeDa1Queries } from "@/lib/terminal-query";
import { TERMINAL_THEMES, terminalTheme } from "@/lib/terminal-themes";
import { cn } from "@/lib/utils";

const RESIZE_PREFIX = "\x01R";
const RESIZE_DEBOUNCE_MS = 150;

type Ghostty = typeof import("ghostty-web");

let ghosttyPromise: Promise<Ghostty> | null = null;

/** Load and compile ghostty-web's WebAssembly once per page. Terminals are
 *  opened rarely, so the module stays out of the main bundle until a tab
 *  mounts; a failed load is retried on the next mount. */
function loadGhostty(): Promise<Ghostty> {
  if (!ghosttyPromise) {
    ghosttyPromise = import("ghostty-web")
      .then(async (mod) => {
        await mod.init();
        return mod;
      })
      .catch((error) => {
        ghosttyPromise = null;
        throw error;
      });
  }
  return ghosttyPromise;
}

const termInstanceCache = new Map<
  string,
  {
    term: GhosttyTerminal;
    wrapper: HTMLDivElement;
    theme: TerminalTheme;
    scrollback: number;
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
  /** Called after a reconnect starts a new PTY, so the tab can point at it. */
  onTerminalReplaced?: (oldTerminalId: string, newTerminalId: string) => void;
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
function bufferText(term: GhosttyTerminal): string {
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

export function TerminalPanel({ terminalId: initialTerminalId, cwd, active = true, onTerminalReplaced }: TerminalPanelProps) {
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
      onTerminalReplaced?.(currentTerminalId, terminalId);
      setCurrentTerminalId(terminalId);
      setReconnectKey((k) => k + 1);
    } finally {
      setReconnecting(false);
    }
  }, [cwd, currentTerminalId, onTerminalReplaced]);

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
  const termRef = useRef<GhosttyTerminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
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
  const [viewKey, setViewKey] = useState(0);
  const [kbOpen, setKbOpen] = useState(false);
  const fullHeightRef = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { settings, updateSetting, loaded: settingsLoaded } = useSettings();
  // The terminal is built only after the stored values load. Remember which
  // ones it was built with, so a later settings change can rebuild it.
  const liveSettingsRef = useRef(settings);
  liveSettingsRef.current = settings;
  const builtThemeRef = useRef<TerminalTheme | null>(null);
  const builtScrollbackRef = useRef<number | null>(null);

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
      if (!activeRef.current) return;
      fitRef.current?.();
    };
    const target: EventTarget = vv ?? window;
    target.addEventListener("resize", handler);
    return () => target.removeEventListener("resize", handler);
  }, []);

  useEffect(() => {
    if (active) {
      fitRef.current?.();
    }
  }, [active]);

  // The pane changes height for reasons the window listeners cannot see: the
  // key bar appears inside it when the keyboard opens, the expanded key panel
  // opens, the sidebar takes width. Fitting on the window resize alone leaves
  // the canvas at its old row count, so the bottom rows — the prompt you were
  // reading — are clipped by the pane. Watch the box itself instead.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (activeRef.current) fitRef.current?.();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = settings.terminalFontSize;
    fitRef.current?.();
  }, [settings.terminalFontSize]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: settings used only for initial values; font size updates live, while theme and scrollback rebuild the terminal view
  useEffect(() => {
    // Building before the stored settings arrive builds the wrong palette,
    // font and scrollback, and the settings effect then rebuilds the view.
    // That rebuild raced the first connect: the stale socket set "connected"
    // after the rebuild had cleared it, so the new terminal asked for a delta
    // instead of a replay and came up empty. Wait for the stored values.
    if (!settingsLoaded) return;
    let cancelled = false;
    let term: GhosttyTerminal | null = null;
    const disposables: Array<{ dispose(): void }> = [];
    // Whether *this* terminal has a buffer already. Scoped to the effect, not
    // shared through a ref, so a socket from a disposed view cannot tell the
    // new terminal to skip the replay.
    let hasConnected = false;

    // ghostty-web answers DSR queries but not DA1, so fish waits ten seconds
    // at startup for a device-attributes reply that never comes. Answer it
    // ourselves unless a future ghostty starts doing so.
    let pendingDa1 = "";
    let ghosttyAnsweredDa1 = false;
    let replayPending = false;

    async function init() {
      const el = containerRef.current;
      if (!el || cancelled) return;
      const touchDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

      const cached = termInstanceCache.get(terminalId);

      // ghostty's fit addon subtracts a fixed 15px for a scrollbar that is
      // drawn over the canvas anyway, which leaves a band down the right of
      // the pane and goes stale while the key bar is appearing. Size the
      // terminal from its own renderer metrics instead, using the full box.
      function fitTerminal() {
        const wrapperEl = term?.element;
        const metrics = term?.renderer?.getMetrics();
        if (!term || !wrapperEl || wrapperEl.clientWidth === 0 || wrapperEl.clientHeight === 0) return;
        if (!metrics?.width || !metrics.height) return;
        const cols = Math.max(2, Math.floor(wrapperEl.clientWidth / metrics.width));
        const rows = Math.max(1, Math.floor(wrapperEl.clientHeight / metrics.height));
        if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
      }
      fitRef.current = fitTerminal;

      if (cached) {
        term = cached.term;
        termRef.current = term;
        // The cached terminal still holds its buffer, so a delta is enough.
        hasConnected = true;
        el.appendChild(cached.wrapper);
        builtThemeRef.current = cached.theme;
        builtScrollbackRef.current = cached.scrollback;
        fitTerminal();
      } else {
        const { Terminal } = await loadGhostty();
        if (cancelled) return;

        const initial = liveSettingsRef.current;
        term = new Terminal({
          cursorBlink: true,
          fontSize: initial.terminalFontSize,
          scrollback: initial.terminalScrollback,
          fontFamily: TERMINAL_FONT_FAMILY,
          theme: terminalTheme(initial.terminalTheme),
        });
        termRef.current = term;
        builtThemeRef.current = initial.terminalTheme;
        builtScrollbackRef.current = initial.terminalScrollback;

        const wrapper = document.createElement("div");
        wrapper.style.width = "100%";
        wrapper.style.height = "100%";
        el.appendChild(wrapper);
        term.open(wrapper);
        fitTerminal();

        // Ghostty makes this wrapper contenteditable and focuses a clipped
        // 1px textarea for input. The contenteditable drew its own caret and
        // capitalised the first letter, and a visible text field draws
        // Android's selection handle over the terminal. Keep the wrapper out
        // of focus and park the textarea off-screen; a pointerdown on the
        // pane focuses it, which still counts as a user gesture for the
        // keyboard.
        wrapper.contentEditable = "false";
        wrapper.style.caretColor = "transparent";
        const textarea = term.textarea;
        if (textarea) {
          textarea.style.left = "-9999px";
          textarea.style.top = "0";
          textarea.style.width = "1px";
          textarea.style.height = "1px";
          textarea.style.clipPath = "none";
          textarea.style.opacity = "0";
          textarea.style.pointerEvents = "none";
          textarea.style.color = "transparent";
          textarea.style.background = "transparent";
          textarea.style.fontSize = "16px";
          textarea.style.caretColor = "transparent";
          textarea.style.userSelect = "none";
          textarea.style.webkitUserSelect = "none";
          textarea.style.setProperty("-webkit-touch-callout", "none");
          textarea.setAttribute("autocapitalize", "off");
          textarea.setAttribute("autocomplete", "off");
          textarea.setAttribute("autocorrect", "off");
          textarea.setAttribute("spellcheck", "false");
          textarea.setAttribute("enterkeyhint", "enter");
          const blockSelection = (event: Event) => event.preventDefault();
          textarea.addEventListener("selectstart", blockSelection);
          textarea.addEventListener("contextmenu", blockSelection);
        }

        termInstanceCache.set(terminalId, {
          term,
          wrapper,
          theme: initial.terminalTheme,
          scrollback: initial.terminalScrollback,
        });
      }

      // Focusing from the pointerdown keeps the keyboard's opening inside the
      // user gesture even though the input lives off-screen.
      if (touchDevice) {
        const focusInput = () => {
          const input = term?.textarea;
          if (input && document.activeElement !== input) input.focus();
        };
        el.addEventListener("pointerdown", focusInput, { passive: true });
        disposables.push({ dispose: () => el.removeEventListener("pointerdown", focusInput) });
      }

      function deliver(data: string) {
        // A replay re-sends the queries the shell asked while the output was
        // produced. Answering them again types the replies into the prompt:
        // the buffer fills with literal DA1 and cursor-position responses.
        if (replayPending) return;
        if (isDa1Response(data)) ghosttyAnsweredDa1 = true;
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
      }

      disposables.push(term.onData(deliver));

      // An on-screen keyboard inserts text rather than producing the keydown
      // events ghostty encodes, and ghostty only reads composition results.
      // Forward the textarea's edits ourselves so phone input reaches the PTY;
      // IME composition still goes through ghostty's compositionend path.
      const inputElement = term.element;
      const softKeyboard = term.textarea;
      if (inputElement) {
        const clearComposer = () => {
          if (!softKeyboard) return;
          softKeyboard.value = "";
          softKeyboard.setSelectionRange(0, 0);
        };
        const onBeforeInput = (event: Event) => {
          const input = event as InputEvent;
          if (input.inputType.includes("Composition")) return;
          switch (input.inputType) {
            case "insertText":
            case "insertFromPaste":
            case "insertReplacementText":
              if (input.data) deliver(input.data);
              event.preventDefault();
              clearComposer();
              break;
            case "insertLineBreak":
            case "insertParagraph":
              deliver("\r");
              event.preventDefault();
              break;
            case "deleteContentBackward":
              deliver("\x7f");
              event.preventDefault();
              break;
            case "deleteContentForward":
              deliver("\x1b[3~");
              event.preventDefault();
              break;
            default:
              break;
          }
        };
        const onInput = (event: Event) => {
          const input = event as InputEvent;
          if (input.isComposing || input.inputType.includes("Composition")) return;
          if (!(event.target instanceof HTMLTextAreaElement) || !event.target.value) return;
          deliver(event.target.value.replace(/\r?\n/g, "\r"));
          clearComposer();
        };
        const onCompositionEnd = () => {
          clearComposer();
        };
        inputElement.addEventListener("beforeinput", onBeforeInput);
        inputElement.addEventListener("input", onInput);
        inputElement.addEventListener("compositionend", onCompositionEnd);
        disposables.push({
          dispose() {
            inputElement.removeEventListener("beforeinput", onBeforeInput);
            inputElement.removeEventListener("input", onInput);
            inputElement.removeEventListener("compositionend", onCompositionEnd);
          },
        });
      }

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
            // scrollLines shows the bar only when it is the wheel path; the
            // touch path has to ask for it explicitly.
            (term as unknown as { showScrollbar?: () => void } | null)?.showScrollbar?.();
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

        const replay = hasConnected ? "0" : "1";
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${window.location.host}/ws/terminal?token=${token}&terminalId=${terminalId}&replay=${replay}`;
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) return;
          retryRef.current = 0;
          setError(null);
          hasConnected = true;
          // A terminal that is hidden (its tab is not active) has not been
          // fitted, so its size is still the constructor default. Sending
          // that would resize the PTY under every other view of it.
          if (term && activeRef.current && term.element?.clientWidth && term.cols > 1 && term.rows > 1) {
            ws.send(`${RESIZE_PREFIX}${term.cols};${term.rows}`);
          }
        };

        ws.onmessage = (event) => {
          if (cancelled) return;
          const data = event.data;
          if (typeof data !== "string") {
            term?.write(data);
            return;
          }
          // A replay is written at the size the buffer was captured at, then
          // fitted to this pane, so a width change reflows instead of jumbling.
          if (data.startsWith("\x01S")) {
            try {
              const size = JSON.parse(data.slice(2)) as { cols?: number; rows?: number };
              if (term && size.cols && size.rows && size.cols > 1 && size.rows > 1) {
                term.resize(size.cols, size.rows);
                replayPending = true;
              }
            } catch {
              // ignore a malformed size frame
            }
            return;
          }
          const wasReplay = replayPending;
          const { queries, pending } = takeDa1Queries(pendingDa1, data);
          pendingDa1 = pending;
          ghosttyAnsweredDa1 = false;
          // ghostty snaps to the bottom on every write, which throws away a
          // reader's scrollback position when output arrives while they are
          // scrolled up (including a delta on returning to the session).
          // Keep the view where it was, shifted by any lines the write added.
          const scrolled = term && term.viewportY > 0 ? term.viewportY : 0;
          const bufferLength = term?.buffer.active.length ?? 0;
          term?.write(data);
          if (scrolled > 0 && term) {
            const added = Math.max(0, term.buffer.active.length - bufferLength);
            term.scrollToLine(scrolled + added);
          }
          if (wasReplay) {
            replayPending = false;
            fitRef.current?.();
          }
          // Queries inside the replay were answered when they were first
          // produced; replying now would type the answer into the shell.
          if (!wasReplay && queries > 0 && !ghosttyAnsweredDa1) {
            for (let i = 0; i < queries; i++) sendData(DA1_RESPONSE);
          }
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
  }, [terminalId, viewKey, settingsLoaded]);

  const sendToTerminal = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }, []);

  // Ghostty bakes the theme and scrollback into the terminal when it is
  // created, so changing either rebuilds the view and reattaches to the same
  // PTY with a full replay. The shell itself is not restarted, and the
  // settings modal stays open.
  const rebuildTerminal = useCallback(() => {
    disposeTerminalInstance(terminalId);
    setViewKey((k) => k + 1);
  }, [terminalId]);

  // A stored theme or scrollback that arrives after the terminal was built
  // (the settings provider loads them asynchronously) needs the same rebuild
  // a settings click gets, or the canvas keeps the default palette.
  useEffect(() => {
    if (!settingsLoaded || !termRef.current) return;
    if (builtThemeRef.current === settings.terminalTheme && builtScrollbackRef.current === settings.terminalScrollback) return;
    rebuildTerminal();
  }, [settingsLoaded, settings.terminalTheme, settings.terminalScrollback, rebuildTerminal]);

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

  const currentTheme = terminalTheme(settings.terminalTheme);

  // The shell reserves the gesture bar's strip for every page; the terminal
  // takes it back with the equal and opposite margin, so its colour runs to the
  // bottom of the screen, and pads its content out of it again.
  return (
    <div
      className="flex flex-col flex-1 min-h-0"
      style={{
        backgroundColor: currentTheme.background,
        marginBottom: "calc(-1 * env(safe-area-inset-bottom))",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <div ref={containerRef} className="absolute inset-0" data-testid="terminal-viewport" />
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
            style={{ backgroundColor: currentTheme.background, color: currentTheme.foreground }}
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
        <div className="shrink-0 relative z-10 border-t border-border/50" style={{ backgroundColor: currentTheme.background }}>
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
                      <div className="h-4 w-4 rounded-sm border border-border/50" style={{ backgroundColor: theme.background }} />
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
