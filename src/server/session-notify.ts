import { basename } from "node:path";
import { formatToolSummary } from "@/lib/tool-summary";
import { getDefaults } from "@/server/defaults";
import { getNotificationSettings } from "@/server/notification-settings";
import { dispatchNotification } from "@/server/notifications";
import { emitSessionAttention } from "@/server/session-attention";
import type { SessionNotifications } from "@/types";
import { debugLog } from "./debug-logger";

/**
 * The three moments a session is worth telling the user about.
 *  - finished: the turn ended and nothing is waiting on them.
 *  - question: the model asked something (AskUserQuestion).
 *  - permission: a tool call is waiting for approval, plan approvals included.
 */
export type SessionEventKind = "finished" | "question" | "permission";

export interface SessionNotifyContext {
  sessionId: string;
  /** The session's name; falls back to the last segment of its directory. */
  name?: string;
  cwd: string;
  notifications?: SessionNotifications;
}

/** The same "finished" push is not worth repeating within a few seconds — a
 *  turn that ends, is answered, and ends again is two events, but a retry loop
 *  is not two notifications. */
const FINISHED_FLOOR_MS = 5_000;
/** Requests are notified once each, so a replayed or repeated store cannot
 *  push twice. Bounded: ids are only interesting while the request is open. */
const NOTIFIED_CAP = 500;

const finishedAt = new Map<string, number>();
const notifiedRequests = new Set<string>();

/** Testing seam: forget what has been notified. */
export function resetSessionNotifyState(): void {
  finishedAt.clear();
  notifiedRequests.clear();
}

function sessionLabel(ctx: SessionNotifyContext): string {
  return ctx.name?.trim() || basename(ctx.cwd) || "Session";
}

/** The first question text out of an AskUserQuestion tool input, which is the
 *  `{questions: [{question, ...}]}` JSON the CLI passes. */
function firstQuestion(input: string | undefined): string {
  if (!input) return "";
  try {
    const parsed = JSON.parse(input) as { questions?: Array<{ question?: string }> };
    const question = parsed.questions?.[0]?.question;
    return typeof question === "string" ? question : "";
  } catch {
    return "";
  }
}

function buildBody(kind: SessionEventKind, detail?: { toolName?: string; input?: string; summary?: string }): string {
  if (kind === "finished") return "Finished working";
  if (kind === "question") {
    const question = firstQuestion(detail?.input);
    return question ? `Asked: ${question}` : "Asked a question";
  }
  const summary = detail?.summary || detail?.toolName || "";
  return summary ? `Needs approval: ${summary}` : "Needs approval";
}

/** What the permission is for: a caller-supplied line, else the same summary
 *  the card shows, parsed from the raw tool input. */
function permissionSummary(detail?: { toolName?: string; input?: string; summary?: string }): string {
  if (detail?.summary) return detail.summary;
  if (!detail?.input) return detail?.toolName ?? "";
  try {
    const parsed = JSON.parse(detail.input) as Record<string, unknown>;
    return formatToolSummary(detail.toolName ?? "", parsed) || (detail.toolName ?? "");
  } catch {
    return detail.toolName ?? "";
  }
}

/**
 * Tell the user about a session event. Two independent things happen here:
 *
 *  - the in-app banner, whenever the global `sessionAlerts` default is on, for
 *    every session — it is about what you are NOT looking at;
 *  - a message to the session's chosen provider, when the session itself has
 *    been set up to send one and this kind is switched on.
 *
 * Failures are swallowed: this runs inside the PTY's event path, and a
 * notification is never a reason for a session to misbehave.
 */
export function notifySessionEvent(
  ctx: SessionNotifyContext,
  kind: SessionEventKind,
  detail?: { requestId?: string; toolName?: string; input?: string; summary?: string },
): void {
  try {
    const name = sessionLabel(ctx);
    if (getDefaults().sessionAlerts) {
      emitSessionAttention({
        sessionId: ctx.sessionId,
        name,
        cwd: ctx.cwd,
        kind,
        requestId: detail?.requestId,
        toolName: detail?.toolName,
        input: detail?.input,
      });
    }

    const prefs = ctx.notifications;
    const providerId = prefs?.providerId;
    if (!providerId) return;
    if (!prefs?.events?.[kind]) return;

    if (kind !== "finished" && detail?.requestId) {
      const key = `${ctx.sessionId}:${detail.requestId}`;
      if (notifiedRequests.has(key)) return;
      if (notifiedRequests.size >= NOTIFIED_CAP) notifiedRequests.clear();
      notifiedRequests.add(key);
    }
    if (kind === "finished") {
      const last = finishedAt.get(ctx.sessionId) ?? 0;
      const now = Date.now();
      if (now - last < FINISHED_FLOOR_MS) return;
      if (finishedAt.size > NOTIFIED_CAP) finishedAt.clear();
      finishedAt.set(ctx.sessionId, now);
    }

    // A provider that was deleted or switched off since the session chose it
    // means silence, deliberately: the settings tab shows it as unavailable,
    // and pushing to a channel the user disabled would be worse.
    const entry = getNotificationSettings().providers.find((p) => p.id === providerId);
    if (!entry?.enabled) return;

    const summary = kind === "permission" ? permissionSummary(detail) : "";

    dispatchNotification({
      title: name,
      body: buildBody(kind, { ...detail, summary }),
      priority: kind === "finished" ? "info" : "warning",
      source: "session",
      url: `/sessions/${ctx.sessionId}?cwd=${encodeURIComponent(ctx.cwd)}`,
      providerIds: [providerId],
      ...(kind === "permission" && detail?.requestId ? { approval: { sessionId: ctx.sessionId, requestId: detail.requestId } } : {}),
    });
  } catch (err) {
    // Never let a notification break the turn, but leave a trace: a swallowed
    // throw here is a silent feature.
    debugLog(`[session-notify] ${kind} for ${ctx.sessionId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
