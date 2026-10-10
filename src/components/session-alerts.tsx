"use client";

import { Bell, Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWebSocket } from "@/hooks/use-websocket";
import { formatToolSummary } from "@/lib/tool-summary";

/** A session needing attention while you are looking at another one. */
interface Alert {
  key: string;
  sessionId: string;
  name: string;
  cwd: string;
  kind: "finished" | "question" | "permission";
  requestId?: string;
  toolName?: string;
  input?: string;
}

/** How long a "turn finished" banner lives: nothing is waiting on the user, so
 *  it is news rather than a task. The other two stay until answered or
 *  dismissed, because they are the ones that need you. */
const FINISHED_TIMEOUT_MS = 8_000;
/** With a banner up and untouched for this long, the stack folds to a strip
 *  that keeps sitting there: the point is to notice it minutes later, not to
 *  have it fill the screen while you finish what you were doing. */
const AUTO_COLLAPSE_MS = 12_000;
/** Expanded banners. More than three and they cover the page they are meant to
 *  be interrupting; the rest wait folded behind the strip. */
const MAX_EXPANDED = 3;

function alertKey(sessionId: string, kind: string, requestId?: string): string {
  return `${sessionId}:${kind}:${requestId ?? ""}`;
}

export function SessionAlerts() {
  const { subscribe, send } = useWebSocket();
  const pathname = usePathname();
  const router = useRouter();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  // Suppress the session on screen. Read from the pathname, not from the shell
  // context: that one is set by the session page and never cleared, so
  // navigating away to the inbox would keep muting that session's alerts.
  const currentSessionId = useMemo(() => {
    const match = pathname?.match(/^\/sessions\/([^/]+)/);
    return match ? match[1] : null;
  }, [pathname]);
  const currentRef = useRef(currentSessionId);
  currentRef.current = currentSessionId;

  const removeAlert = useCallback((key: string) => {
    setAlerts((prev) => prev.filter((a) => a.key !== key));
  }, []);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === "request:resolved") {
        // Answered somewhere else — another tab, or the buttons on a push
        // notification. Whatever is showing for it goes.
        setAlerts((prev) => prev.filter((a) => a.requestId !== msg.requestId));
        return;
      }
      if (msg.type !== "session:attention") return;
      if (msg.sessionId === currentRef.current) return;

      const key = alertKey(msg.sessionId, msg.kind, msg.requestId);
      setAlerts((prev) => {
        if (prev.some((a) => a.key === key)) return prev;
        const next: Alert = {
          key,
          sessionId: msg.sessionId,
          name: msg.name,
          cwd: msg.cwd,
          kind: msg.kind,
          requestId: msg.requestId,
          toolName: msg.toolName,
          input: msg.input,
        };
        return [...prev, next];
      });
      setCollapsed(false);
    });
  }, [subscribe]);

  // Finished banners clear themselves; the others are waiting on an answer.
  useEffect(() => {
    const timers = alerts.filter((a) => a.kind === "finished").map((a) => setTimeout(() => removeAlert(a.key), FINISHED_TIMEOUT_MS));
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [alerts, removeAlert]);

  // Fold the stack after a while, but leave it on screen.
  const foldedRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(foldedRef.current);
    if (collapsed || alerts.length === 0) return;
    foldedRef.current = setTimeout(() => setCollapsed(true), AUTO_COLLAPSE_MS);
    return () => clearTimeout(foldedRef.current);
  }, [alerts, collapsed]);

  const respond = useCallback(
    (alert: Alert, allowed: boolean) => {
      if (!alert.requestId) return;
      send({
        type: "permission:response",
        sessionId: alert.sessionId,
        requestId: alert.requestId,
        allowed,
        permissionMode: "allow",
      });
      removeAlert(alert.key);
    },
    [send, removeAlert],
  );

  const open = useCallback(
    (alert: Alert) => {
      router.push(`/sessions/${alert.sessionId}?cwd=${encodeURIComponent(alert.cwd)}`);
      removeAlert(alert.key);
    },
    [router, removeAlert],
  );

  if (alerts.length === 0) return null;

  const label = (alert: Alert) => {
    if (alert.kind === "finished") return "finished a turn";
    if (alert.kind === "question") return "asked a question";
    return "needs approval";
  };

  const summary = (alert: Alert) => {
    if (alert.kind !== "permission") return "";
    try {
      return formatToolSummary(alert.toolName ?? "", JSON.parse(alert.input || "{}") as Record<string, unknown>);
    } catch {
      return "";
    }
  };

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        data-testid="session-alerts-collapsed"
        className="fixed left-1/2 top-[4.25rem] z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs shadow-lg hover:bg-accent"
      >
        <Bell className="h-3.5 w-3.5 text-yellow-500" />
        {alerts.length === 1 ? `${alerts[0].name} ${label(alerts[0])}` : `${alerts.length} sessions need you`}
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    );
  }

  const shown = alerts.slice(0, MAX_EXPANDED);
  const hidden = alerts.length - shown.length;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-[4.25rem] z-40 flex flex-col items-center gap-2 px-2"
      data-testid="session-alerts"
    >
      {shown.map((alert) => (
        <div
          key={alert.key}
          data-testid={`session-alert-${alert.kind}`}
          className="pointer-events-auto flex w-full max-w-xl items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs shadow-lg"
        >
          <Bell className="h-3.5 w-3.5 shrink-0 text-yellow-500" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="truncate font-medium">{alert.name}</span>
              <span className="shrink-0 text-muted-foreground">{label(alert)}</span>
            </div>
            {summary(alert) && <div className="truncate font-mono text-[11px] text-muted-foreground">{summary(alert)}</div>}
          </div>
          {alert.kind === "permission" && (
            <>
              <button
                type="button"
                onClick={() => respond(alert, true)}
                data-testid="session-alert-approve"
                className="flex shrink-0 items-center gap-1 rounded bg-primary px-2 py-1 text-primary-foreground hover:opacity-90"
              >
                <Check className="h-3 w-3" />
                Approve
              </button>
              <button
                type="button"
                onClick={() => respond(alert, false)}
                data-testid="session-alert-deny"
                className="shrink-0 rounded border px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Deny
              </button>
            </>
          )}
          {alert.kind !== "permission" && (
            <button
              type="button"
              onClick={() => open(alert)}
              data-testid="session-alert-open"
              className="shrink-0 rounded bg-primary px-2 py-1 text-primary-foreground hover:opacity-90"
            >
              Open
            </button>
          )}
          <button
            type="button"
            onClick={() => removeAlert(alert.key)}
            title="Dismiss"
            data-testid="session-alert-dismiss"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="pointer-events-auto flex items-center gap-2">
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="rounded-full border bg-card px-3 py-1 text-[11px] shadow hover:bg-accent"
          >
            {hidden} more
          </button>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title="Collapse, but keep them here"
          data-testid="session-alerts-collapse"
          className="flex items-center gap-1 rounded-full border bg-card px-2.5 py-1 text-[11px] text-muted-foreground shadow hover:bg-accent"
        >
          <ChevronUp className="h-3 w-3" />
          Hide
        </button>
      </div>
    </div>
  );
}
