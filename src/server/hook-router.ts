import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "StopFailure"
  | "UserPromptSubmit"
  | "Notification"
  | "PermissionRequest";

export interface HookResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface PermissionDecision {
  behavior: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
}

type HookCallbackReturn = Promise<HookResponse | undefined> | HookResponse | undefined;
type HookCallback = (payload: Record<string, unknown>) => HookCallbackReturn;

export interface SessionHookHandler {
  onPreToolUse?: HookCallback;
  onPostToolUse?: HookCallback;
  onStop?: HookCallback;
  onStopFailure?: HookCallback;
  onUserPromptSubmit?: HookCallback;
  onNotification?: HookCallback;
  /** Must resolve with the permission decision. The promise can take as long as needed. */
  onPermissionRequest?: (payload: Record<string, unknown>) => Promise<PermissionDecision>;
}

interface RegisteredSession {
  token: string;
  handler: SessionHookHandler;
  pendingResponses: Set<ServerResponse>;
}

export class HookRouter {
  private server: Server | null = null;
  private port = 0;
  private sessions = new Map<string, RegisteredSession>();

  async start(host = "127.0.0.1", port = 0): Promise<{ host: string; port: number }> {
    this.server = createServer((req, res) => this.handle(req, res));
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

  unregister(sessionId: string): void {
    const registered = this.sessions.get(sessionId);
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

    const fn =
      eventName === "PreToolUse"
        ? handler.onPreToolUse
        : eventName === "PostToolUse"
          ? handler.onPostToolUse
          : eventName === "Stop"
            ? handler.onStop
            : eventName === "StopFailure"
              ? handler.onStopFailure
              : eventName === "UserPromptSubmit"
                ? handler.onUserPromptSubmit
                : eventName === "Notification"
                  ? handler.onNotification
                  : undefined;

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
