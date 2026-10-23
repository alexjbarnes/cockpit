import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PermissionDenied"
  | "Stop"
  | "StopFailure"
  | "UserPromptSubmit"
  | "UserPromptExpansion"
  | "SubagentStart"
  | "SubagentStop"
  | "Notification"
  | "PermissionRequest"
  | "PreCompact"
  | "PostCompact"
  | "SessionStart"
  | "SessionEnd"
  | "Elicitation"
  | "ElicitationResult"
  | "TaskCreated"
  | "TaskCompleted"
  | "TeammateIdle";

export interface HookResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface PermissionDecision {
  behavior: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
  /** The CLI's own permission updates to apply along with the allow — one of
   *  the suggestions its PermissionRequest payload offered, echoed back. This
   *  is what makes the card's "always" answer save a rule rather than just
   *  letting this one call through. */
  updatedPermissions?: Record<string, unknown>[];
}

/**
 * Who decided a permission prompt: the user; cockpit's bypass; cockpit's own
 * rules (a job's allowed tools, the assistant's read-only tools); the
 * terminal, without cockpit; or nobody, because the turn was interrupted or
 * the session ended. Recorded with telemetry, which cannot tell them apart.
 */
export type PermissionAnswerer = "you" | "bypass" | "cockpit" | "terminal" | "interrupted" | "ended";

type HookCallbackReturn = Promise<HookResponse | undefined> | HookResponse | undefined;
type HookCallback = (payload: Record<string, unknown>) => HookCallbackReturn;

export interface SessionHookHandler {
  onPreToolUse?: HookCallback;
  onPostToolUse?: HookCallback;
  onPostToolUseFailure?: HookCallback;
  onPermissionDenied?: HookCallback;
  onStop?: HookCallback;
  onStopFailure?: HookCallback;
  onUserPromptSubmit?: HookCallback;
  onUserPromptExpansion?: HookCallback;
  onSubagentStart?: HookCallback;
  onSubagentStop?: HookCallback;
  onNotification?: HookCallback;
  onPreCompact?: HookCallback;
  onPostCompact?: HookCallback;
  onSessionStart?: HookCallback;
  onSessionEnd?: HookCallback;
  onElicitation?: HookCallback;
  onElicitationResult?: HookCallback;
  onTaskCreated?: HookCallback;
  onTaskCompleted?: HookCallback;
  onTeammateIdle?: HookCallback;
  /** Must resolve with the permission decision. The promise can take as long as needed. */
  onPermissionRequest?: (payload: Record<string, unknown>) => Promise<PermissionDecision>;
}

interface RegisteredSession {
  token: string;
  handler: SessionHookHandler;
  pendingResponses: Set<ServerResponse>;
}

/** Takes the requests under /otel/: the CLI's OpenTelemetry export, which
 *  authenticates with a token of its own rather than a hook registration. */
export type OtelHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export class HookRouter {
  private server: Server | null = null;
  private port = 0;
  private sessions = new Map<string, RegisteredSession>();
  private otelHandler: OtelHandler | null = null;

  setOtelHandler(handler: OtelHandler | null): void {
    this.otelHandler = handler;
  }

  async start(host = "127.0.0.1", port = 0): Promise<{ host: string; port: number }> {
    this.server = createServer((req, res) => {
      if (this.otelHandler && (req.url ?? "").startsWith("/otel/")) {
        this.otelHandler(req, res).catch((err) => {
          console.error("[hook-router] otel request failed:", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end();
          }
        });
        return;
      }
      void this.handle(req, res);
    });
    // The OpenTelemetry exporters keep their connection open and post every
    // few seconds, the same cadence as Node's default keep-alive timeout, so
    // a reused socket could be closed under a request. Hook calls are one-shot
    // and unaffected.
    this.server.keepAliveTimeout = 65_000;
    this.server.headersTimeout = 66_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") this.port = addr.port;
        resolve();
      });
    });
    return { host, port: this.port };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  getUrl(host = "127.0.0.1"): string {
    return `http://${host}:${this.port}`;
  }

  register(sessionId: string, handler: SessionHookHandler): string {
    const token = randomBytes(24).toString("hex");
    this.sessions.set(sessionId, { token, handler, pendingResponses: new Set() });
    return token;
  }

  /**
   * Remove a session's registration. With a token, only that registration: a
   * session respawned before its old process finished cleaning up has already
   * registered again under the same id, and the old cleanup must not remove
   * the new spawn's registration (which turned every later hook into a 403).
   */
  unregister(sessionId: string, token?: string): void {
    const registered = this.sessions.get(sessionId);
    if (registered && token !== undefined && registered.token !== token) return;
    if (registered) {
      for (const res of registered.pendingResponses) {
        if (!res.writableEnded) {
          res.statusCode = 503;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ exitCode: 0, stderr: "session restarted" }));
        }
      }
      registered.pendingResponses.clear();
    }
    this.sessions.delete(sessionId);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const url = req.url || "";
    const match = url.match(/^\/hook\/([A-Za-z]+)(?:\?.*)?$/);
    if (!match) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const eventName = match[1] as HookEventName;

    const sessionId = req.headers["x-cockpit-session"];
    const token = req.headers["x-cockpit-token"];
    if (typeof sessionId !== "string" || typeof token !== "string") {
      res.statusCode = 400;
      res.end("missing session or token header");
      return;
    }

    const registered = this.sessions.get(sessionId);
    if (!registered || registered.token !== token) {
      res.statusCode = 403;
      res.end("unauthorized");
      return;
    }

    let body = "";
    req.setEncoding("utf8");
    for await (const chunk of req) body += chunk;

    let payload: Record<string, unknown>;
    try {
      payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    } catch {
      res.statusCode = 400;
      res.end("invalid json");
      return;
    }

    console.log(`[hook-router] received ${eventName} for session ${sessionId.slice(0, 8)}`);
    registered.pendingResponses.add(res);
    try {
      const response = await this.dispatch(registered.handler, eventName, payload);
      if (!res.writableEnded) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(response));
      }
      console.log(`[hook-router] dispatched ${eventName} for session ${sessionId.slice(0, 8)} ok`);
    } catch (err) {
      console.error(`[hook-router] dispatch ${eventName} for session ${sessionId.slice(0, 8)} THREW:`, err);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ exitCode: 1, stderr: String(err) }));
      }
    } finally {
      registered.pendingResponses.delete(res);
    }
  }

  private async dispatch(handler: SessionHookHandler, eventName: HookEventName, payload: Record<string, unknown>): Promise<HookResponse> {
    if (eventName === "PermissionRequest") {
      if (!handler.onPermissionRequest) {
        return { stdout: permissionAllowJson(), exitCode: 0 };
      }
      const decision = await handler.onPermissionRequest(payload);
      return { stdout: permissionDecisionJson(decision), exitCode: 0 };
    }

    const handlerMap: Partial<Record<HookEventName, HookCallback | undefined>> = {
      PreToolUse: handler.onPreToolUse,
      PostToolUse: handler.onPostToolUse,
      PostToolUseFailure: handler.onPostToolUseFailure,
      PermissionDenied: handler.onPermissionDenied,
      Stop: handler.onStop,
      StopFailure: handler.onStopFailure,
      UserPromptSubmit: handler.onUserPromptSubmit,
      UserPromptExpansion: handler.onUserPromptExpansion,
      SubagentStart: handler.onSubagentStart,
      SubagentStop: handler.onSubagentStop,
      Notification: handler.onNotification,
      PreCompact: handler.onPreCompact,
      PostCompact: handler.onPostCompact,
      SessionStart: handler.onSessionStart,
      SessionEnd: handler.onSessionEnd,
      Elicitation: handler.onElicitation,
      ElicitationResult: handler.onElicitationResult,
      TaskCreated: handler.onTaskCreated,
      TaskCompleted: handler.onTaskCompleted,
      TeammateIdle: handler.onTeammateIdle,
    };
    const fn = handlerMap[eventName];

    if (!fn) {
      console.log(`[hook-router] no handler for ${eventName}, returning empty response`);
      return {};
    }
    const result = await fn(payload);
    return result || {};
  }
}

function permissionAllowJson(): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
}

function permissionDecisionJson(decision: PermissionDecision): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
}
