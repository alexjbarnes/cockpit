import type { ChatMessage } from "@/types";
import { cleanupHookSettings, prepareHookSettings } from "./claude-settings";
import type { ParsedEvent } from "./event-parser";
import { newPermissionRequestId, translateHookEvent } from "./hook-event-translator";
import type { HookRouter, PermissionDecision, SessionHookHandler } from "./hook-router";
import { PtySession } from "./pty-session";
import { loadLastAssistantMessage } from "./transcript";

export interface PtyRuntimeOptions {
  sessionId: string;
  cwd: string;
  cliSessionId: string;
  hookRouter: HookRouter;
  /** Receives translated ParsedEvents for the existing stream-processor pipeline. */
  onEvents: (events: ParsedEvent[]) => void;
  onError: (err: string) => void;
  onExit: (info: { exitCode: number; signal?: number }) => void;
  /** Override the claude binary path. */
  claudeBin?: string;
  /** Extra args passed to claude after --verbose --settings. */
  extraArgs?: string[];
  /** Extra env vars merged on top of process.env. */
  extraEnv?: Record<string, string>;
  /** Tools to pre-authorize at settings level so PermissionRequest never fires. */
  allowList?: string[];
  denyList?: string[];
  /** Optional debug callback for raw PTY data chunks. */
  onPtyData?: (chunk: string) => void;
}

/**
 * Owns a claude PTY process plus its HookRouter registration. Translates
 * hook payloads into ParsedEvents and pumps them through opts.onEvents so
 * SessionManager's existing stream-processor pipeline drives status, todos,
 * pending permissions, etc.
 *
 * PermissionRequest hooks block the PTY until cockpit responds. We hold the
 * resolver in `pendingPermissions` and the caller calls
 * `notifyPermissionDecision` from its UI-facing respondToPermission path.
 */
export class PtyRuntime {
  private readonly opts: PtyRuntimeOptions;
  private pty: PtySession | null = null;
  private settingsPath: string | null = null;
  private readonly pendingPermissions = new Map<string, (decision: PermissionDecision) => void>();
  private exited = false;

  constructor(opts: PtyRuntimeOptions) {
    this.opts = opts;
  }

  get pid(): number {
    return this.pty?.pid ?? -1;
  }

  get isAlive(): boolean {
    return !!this.pty && !this.exited;
  }

  async start(initialText?: string): Promise<void> {
    const { sessionId, cwd, hookRouter } = this.opts;

    const token = hookRouter.register(sessionId, this.buildHandler());
    const { settingsPath, env } = await prepareHookSettings({
      sessionId,
      hookUrl: hookRouter.getUrl(),
      hookToken: token,
      allowList: this.opts.allowList,
      denyList: this.opts.denyList,
    });
    this.settingsPath = settingsPath;

    this.pty = new PtySession({
      cwd,
      settingsPath,
      env: { ...env, ...(this.opts.extraEnv ?? {}) },
      extraArgs: this.opts.extraArgs,
      bin: this.opts.claudeBin,
      onData: this.opts.onPtyData,
      onExit: (info) => {
        this.exited = true;
        this.opts.onExit(info);
        this.cleanup().catch(() => {});
      },
    });

    try {
      await this.pty.start();
    } catch (err) {
      await this.cleanup();
      throw err;
    }

    if (initialText) {
      await this.pty.sendText(initialText);
    }
  }

  async sendText(text: string): Promise<void> {
    if (!this.pty) throw new Error("PtyRuntime not started");
    await this.pty.sendText(text);
  }

  sendSlash(command: string): void {
    if (!this.pty) throw new Error("PtyRuntime not started");
    this.pty.sendSlash(command);
  }

  sendKey(key: string): void {
    if (!this.pty) throw new Error("PtyRuntime not started");
    this.pty.sendKey(key);
  }

  /** Sends Esc to claude — the interactive REPL treats it as interrupt. */
  interrupt(): void {
    if (!this.pty) return;
    this.pty.sendKey("\x1b");
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  async kill(signal?: string): Promise<void> {
    if (this.pty) {
      this.pty.kill(signal);
      this.pty = null;
    }
    // Resolve any in-flight permission promises so the bridge subprocess can exit.
    for (const [, resolve] of this.pendingPermissions) {
      resolve({ behavior: "deny", message: "session ended" });
    }
    this.pendingPermissions.clear();
    await this.cleanup();
  }

  /** Called by SessionManager.respondToPermission when this session is on the pty runtime. */
  notifyPermissionDecision(requestId: string, decision: PermissionDecision): boolean {
    const resolver = this.pendingPermissions.get(requestId);
    if (!resolver) return false;
    this.pendingPermissions.delete(requestId);
    resolver(decision);
    return true;
  }

  private buildHandler(): SessionHookHandler {
    return {
      onPreToolUse: async (payload) => {
        const toolId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : "";
        const hookEvents = translateHookEvent("PreToolUse", payload);

        if (toolId) {
          try {
            const loaded = await loadLastAssistantMessage(this.opts.cliSessionId, this.opts.cwd);
            if (loaded) {
              const snapshot = this.buildLiveSnapshot(loaded, toolId);
              if (snapshot) this.emit([{ type: "streaming_snapshot", message: snapshot }]);
            }
          } catch {
            // fall through
          }
        }

        this.emit(hookEvents);
      },
      onPostToolUse: (payload) => {
        this.emit(translateHookEvent("PostToolUse", payload));
      },
      onStop: async (payload) => {
        const events = translateHookEvent("Stop", payload);
        const msgDoneIdx = events.findIndex((e) => e.type === "message_done");
        if (msgDoneIdx !== -1) {
          try {
            const loaded = await loadLastAssistantMessage(this.opts.cliSessionId, this.opts.cwd);
            if (loaded) {
              events[msgDoneIdx] = { type: "message_done", message: loaded, clearPending: true };
            }
          } catch {
            // fall back to hook-assembled message
          }
        }
        this.emit(events);
      },
      onUserPromptSubmit: (payload) => {
        this.emit(translateHookEvent("UserPromptSubmit", payload));
      },
      onNotification: (payload) => {
        this.emit(translateHookEvent("Notification", payload));
      },
      onPermissionRequest: (payload) => this.handlePermissionRequest(payload),
    };
  }

  private buildLiveSnapshot(message: ChatMessage, currentToolId: string): ChatMessage | null {
    // Guard: if JSONL hasn't caught up yet, the current tool won't be in the message.
    const hasCurrentTool = message.blocks.some((b) => b.type === "tool_use" && b.toolUse.id === currentToolId);
    if (!hasCurrentTool) return null;

    // Mark the current tool as running — transcript records it as "done" before the result arrives.
    const blocks = message.blocks.map((b) => {
      if (b.type === "tool_use" && b.toolUse.id === currentToolId) {
        return { ...b, toolUse: { ...b.toolUse, status: "running" as const, output: "" } };
      }
      return b;
    });
    const toolUses = message.toolUses.map((t) => (t.id === currentToolId ? { ...t, status: "running" as const, output: "" } : t));
    return { ...message, blocks, toolUses };
  }

  private handlePermissionRequest(payload: Record<string, unknown>): Promise<PermissionDecision> {
    const requestId = newPermissionRequestId();
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "unknown";
    const toolInput = payload.tool_input as Record<string, unknown> | undefined;

    const event: ParsedEvent = {
      type: "permission_request",
      requestId,
      toolName,
      toolInput: toolInput ? JSON.stringify(toolInput) : "",
      rawToolInput: toolInput,
    };

    return new Promise<PermissionDecision>((resolve) => {
      this.pendingPermissions.set(requestId, resolve);
      try {
        this.opts.onEvents([event]);
      } catch (err) {
        this.pendingPermissions.delete(requestId);
        resolve({ behavior: "deny", message: `cockpit handler error: ${String(err)}` });
      }
    });
  }

  private emit(events: ParsedEvent[]): void {
    if (events.length === 0) return;
    try {
      this.opts.onEvents(events);
    } catch (err) {
      this.opts.onError(err instanceof Error ? err.message : String(err));
    }
  }

  private async cleanup(): Promise<void> {
    this.opts.hookRouter.unregister(this.opts.sessionId);
    if (this.settingsPath) {
      await cleanupHookSettings(this.opts.sessionId).catch(() => {});
      this.settingsPath = null;
    }
  }
}
