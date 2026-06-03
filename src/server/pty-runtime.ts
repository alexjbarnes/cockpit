import { v4 as uuidv4 } from "uuid";
import { cleanupHookSettings, prepareHookSettings } from "./claude-settings";
import { fetchCliInitData } from "./cli-init-fetch";
import { logDiag } from "./debug-logger";
import type { ParsedEvent } from "./event-parser";
import { newPermissionRequestId, translateHookEvent } from "./hook-event-translator";
import type { HookRouter, PermissionDecision, SessionHookHandler } from "./hook-router";
import { PtySession } from "./pty-session";

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
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escape sequences
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export class PtyRuntime {
  private readonly opts: PtyRuntimeOptions;
  private pty: PtySession | null = null;
  private settingsPath: string | null = null;
  private readonly pendingPermissions = new Map<string, (decision: PermissionDecision) => void>();
  private exited = false;
  private cleaned = false;
  /** Resolver armed by deliverInitialPrompt; fired when UserPromptSubmit confirms the first prompt landed. */
  private promptAccepted: (() => void) | null = null;
  private ptyOutputBuffer = "";
  private errorDebounce: ReturnType<typeof setTimeout> | null = null;

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
    const startAt = Date.now();
    logDiag(sessionId, "pty:start-enter", { hasInitialText: !!initialText });

    const token = hookRouter.register(sessionId, this.buildHandler());
    const { settingsPath, env } = await prepareHookSettings({
      sessionId,
      hookUrl: hookRouter.getUrl(),
      hookToken: token,
      allowList: this.opts.allowList,
      denyList: this.opts.denyList,
    });
    this.settingsPath = settingsPath;
    logDiag(sessionId, "pty:hooks-ready", { elapsedMs: Date.now() - startAt });

    this.pty = new PtySession({
      cwd,
      settingsPath,
      env: { ...env, ...(this.opts.extraEnv ?? {}) },
      extraArgs: this.opts.extraArgs,
      bin: this.opts.claudeBin,
      onData: (chunk) => {
        this.scanForErrors(chunk);
        this.opts.onPtyData?.(chunk);
      },
      onExit: (info) => {
        this.exited = true;
        this.opts.onExit(info);
        this.cleanup().catch(() => {});
      },
    });

    try {
      await this.pty.start();
    } catch (err) {
      logDiag(sessionId, "pty:process-start-failed", {
        elapsedMs: Date.now() - startAt,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.cleanup();
      throw err;
    }
    logDiag(sessionId, "pty:process-started", { pid: this.pid, elapsedMs: Date.now() - startAt });

    if (initialText) {
      await this.deliverInitialPrompt(initialText);
    }

    logDiag(sessionId, "pty:start-complete", { elapsedMs: Date.now() - startAt });
    this.fetchInitData();
  }

  /**
   * Type the first prompt into the freshly spawned TUI and confirm the CLI
   * accepted it. waitForReplReady is only a heuristic (first 100 bytes plus a
   * 2s settle), so on a slow or quiet machine the input box may not be live
   * when the keystrokes land and they are swallowed with no error. Without a
   * check the turn never starts and the only backstop is the caller's watchdog,
   * which for scheduled jobs is a silent 30-60 minute timeout with an empty
   * transcript. Resend until the UserPromptSubmit hook confirms acceptance,
   * then fail fast so the job reports an error instead of hanging.
   */
  private async deliverInitialPrompt(text: string): Promise<void> {
    const { sessionId } = this.opts;
    const MAX_ATTEMPTS = 4;
    const CONFIRM_TIMEOUT_MS = 8000;
    logDiag(sessionId, "pty:deliver-begin", { textLen: text.length, maxAttempts: MAX_ATTEMPTS });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const pty = this.pty;
      if (this.exited || !pty) {
        logDiag(sessionId, "pty:deliver-aborted", { attempt, exited: this.exited, hasPty: !!pty });
        throw new Error("claude exited before the initial prompt was delivered");
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const accepted = new Promise<boolean>((resolve) => {
        this.promptAccepted = () => resolve(true);
        timer = setTimeout(() => resolve(false), CONFIRM_TIMEOUT_MS);
      });
      const attemptAt = Date.now();
      logDiag(sessionId, "pty:deliver-attempt", { attempt });
      await pty.sendText(text);
      const ok = await accepted;
      if (timer) clearTimeout(timer);
      this.promptAccepted = null;
      if (ok) {
        logDiag(sessionId, "pty:deliver-accepted", { attempt, waitedMs: Date.now() - attemptAt });
        return;
      }
      logDiag(sessionId, "pty:deliver-timeout", { attempt, waitedMs: Date.now() - attemptAt });
      console.log(`[pty-runtime] initial prompt not accepted for ${sessionId.slice(0, 8)} (attempt ${attempt}/${MAX_ATTEMPTS}), resending`);
    }
    logDiag(sessionId, "pty:deliver-failed", { attempts: MAX_ATTEMPTS });
    throw new Error(`claude did not accept the initial prompt after ${MAX_ATTEMPTS} attempts`);
  }

  private fetchInitData(): void {
    const { sessionId } = this.opts;
    const sid = sessionId.slice(0, 8);
    console.log(`[pty-runtime] fetching CLI init data for session ${sid}`);
    logDiag(sessionId, "pty:init-fetch-begin");
    fetchCliInitData({ cwd: this.opts.cwd, bin: this.opts.claudeBin })
      .then((initData) => {
        if (initData && !this.exited) {
          console.log(`[pty-runtime] emitting init event for session ${sid}: ${initData.slashCommands.length} commands`);
          logDiag(sessionId, "pty:init-fetch-done", {
            slashCommands: initData.slashCommands.length,
            mcpServers: initData.mcpServers?.length ?? 0,
          });
          this.emit([{ type: "init", initData }]);
        } else {
          console.log(`[pty-runtime] init fetch returned ${initData ? "data but session exited" : "null"} for session ${sid}`);
          logDiag(sessionId, "pty:init-fetch-empty", { exited: this.exited, hadData: !!initData });
        }
      })
      .catch((err) => {
        console.log(`[pty-runtime] init fetch failed for session ${sid}: ${err}`);
        logDiag(sessionId, "pty:init-fetch-failed", { error: err instanceof Error ? err.message : String(err) });
      });
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
    for (const [, resolve] of this.pendingPermissions) {
      resolve({ behavior: "deny", message: "interrupted" });
    }
    this.pendingPermissions.clear();
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  async kill(signal?: string): Promise<void> {
    this.cancelErrorDebounce();
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
    if (!resolver) {
      logDiag(this.opts.sessionId, "pty:permission-decision-unmatched", { requestId, behavior: decision.behavior });
      return false;
    }
    this.pendingPermissions.delete(requestId);
    logDiag(this.opts.sessionId, "pty:permission-decision", {
      requestId,
      behavior: decision.behavior,
      pending: this.pendingPermissions.size,
    });
    resolver(decision);
    return true;
  }

  private buildHandler(): SessionHookHandler {
    return {
      onPreToolUse: (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "unknown";
        const cliSession = typeof payload.session_id === "string" ? payload.session_id.slice(0, 8) : "none";
        const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id.slice(0, 12) : "none";
        console.log(`[pty-runtime] PreToolUse: tool=${toolName} cli_session=${cliSession} tool_use_id=${toolUseId}`);
        this.emit(translateHookEvent("PreToolUse", payload));
      },
      onPostToolUse: (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "unknown";
        const cliSession = typeof payload.session_id === "string" ? payload.session_id.slice(0, 8) : "none";
        const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id.slice(0, 12) : "none";
        console.log(`[pty-runtime] PostToolUse: tool=${toolName} cli_session=${cliSession} tool_use_id=${toolUseId}`);
        this.emit(translateHookEvent("PostToolUse", payload));
      },
      onStop: (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        console.log(`[pty-runtime] Stop hook received for session ${this.opts.sessionId.slice(0, 8)}`);
        const events = translateHookEvent("Stop", payload);
        console.log(`[pty-runtime] Stop translated to ${events.length} events: [${events.map((e) => e.type).join(", ")}]`);
        this.emit(events);
      },
      onStopFailure: (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        const errorType = typeof payload.error_type === "string" ? payload.error_type : "unknown";
        const errorMessage = typeof payload.error_message === "string" ? payload.error_message : "Unknown error";
        console.log(`[pty-runtime] StopFailure hook for session ${this.opts.sessionId.slice(0, 8)}: ${errorType} - ${errorMessage}`);
        this.emit(translateHookEvent("StopFailure", payload));
        this.opts.onError(`${errorMessage} (${errorType})`);
      },
      onUserPromptSubmit: (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        logDiag(this.opts.sessionId, "pty:hook-user-prompt-submit", { armed: !!this.promptAccepted });
        this.promptAccepted?.();
        this.emit(translateHookEvent("UserPromptSubmit", payload));
      },
      onUserPromptExpansion: (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        this.promptAccepted?.();
        const cmd = typeof payload.command_name === "string" ? payload.command_name : "unknown";
        const sid = this.opts.sessionId.slice(0, 8);
        console.log(`[pty-runtime] UserPromptExpansion: command=${cmd}, session=${sid}`);
        this.emit(translateHookEvent("UserPromptExpansion", payload));
      },
      onSubagentStart: (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        const cliSession = typeof payload.session_id === "string" ? payload.session_id.slice(0, 8) : "none";
        const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id.slice(0, 12) : "none";
        const agentType = typeof payload.agent_type === "string" ? payload.agent_type : "unknown";
        const desc = typeof payload.description === "string" ? payload.description.slice(0, 80) : "";
        console.log(`[pty-runtime] SubagentStart: cli_session=${cliSession} tool_use_id=${toolUseId} type=${agentType} desc="${desc}"`);
        console.log(`[pty-runtime] SubagentStart full payload keys: ${Object.keys(payload).join(", ")}`);
        this.emit(translateHookEvent("SubagentStart", payload));
      },
      onSubagentStop: (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        const cliSession = typeof payload.session_id === "string" ? payload.session_id.slice(0, 8) : "none";
        const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id.slice(0, 12) : "none";
        const agentType = typeof payload.agent_type === "string" ? payload.agent_type : "unknown";
        console.log(`[pty-runtime] SubagentStop: cli_session=${cliSession} tool_use_id=${toolUseId} type=${agentType}`);
        console.log(`[pty-runtime] SubagentStop full payload keys: ${Object.keys(payload).join(", ")}`);
        this.emit(translateHookEvent("SubagentStop", payload));
      },
      onPreCompact: (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        console.log(`[pty-runtime] PreCompact for session ${this.opts.sessionId.slice(0, 8)}`);
        this.emit(translateHookEvent("PreCompact", payload));
      },
      onPostCompact: (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        console.log(`[pty-runtime] PostCompact for session ${this.opts.sessionId.slice(0, 8)}`);
        this.emit(translateHookEvent("PostCompact", payload));
      },
      onNotification: (payload) => {
        this.cancelErrorDebounce();
        this.emit(translateHookEvent("Notification", payload));
      },
      onPermissionRequest: (payload) => this.handlePermissionRequest(payload),
    };
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

    logDiag(this.opts.sessionId, "pty:permission-request", { requestId, toolName });
    return new Promise<PermissionDecision>((resolve) => {
      this.pendingPermissions.set(requestId, resolve);
      try {
        this.opts.onEvents([event]);
      } catch (err) {
        this.pendingPermissions.delete(requestId);
        logDiag(this.opts.sessionId, "pty:permission-handler-error", { requestId, toolName, error: String(err) });
        resolve({ behavior: "deny", message: `cockpit handler error: ${String(err)}` });
      }
    });
  }

  private emit(events: ParsedEvent[]): void {
    if (events.length === 0) return;
    try {
      this.opts.onEvents(events);
    } catch (err) {
      console.error(`[pty-runtime] onEvents threw for session ${this.opts.sessionId.slice(0, 8)}:`, err);
      this.opts.onError(err instanceof Error ? err.message : String(err));
    }
  }

  private cancelErrorDebounce(): void {
    if (this.errorDebounce) {
      clearTimeout(this.errorDebounce);
      this.errorDebounce = null;
    }
  }

  private scanForErrors(chunk: string): void {
    this.ptyOutputBuffer += chunk;
    if (this.ptyOutputBuffer.length > 8 * 1024) {
      this.ptyOutputBuffer = this.ptyOutputBuffer.slice(-4 * 1024);
    }
    if (this.errorDebounce) return;

    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal control chars
    const clean = this.ptyOutputBuffer.replace(ANSI_RE, "").replace(/[\x00-\x1f]/g, "");
    const match = clean.match(/API\s*Error:\s*(\d+)\s*([^✓✗❯]*)/) || clean.match(/APIError:\s*(\d+)\s*(.*)/);
    if (!match) return;

    const httpCode = match[1];
    const detail = match[2].trim().slice(0, 200);
    const errMsg = detail ? `${detail} (HTTP ${httpCode})` : `API Error (HTTP ${httpCode})`;

    this.errorDebounce = setTimeout(() => {
      this.errorDebounce = null;
      this.ptyOutputBuffer = "";

      console.log(`[pty-runtime] API error detected for session ${this.opts.sessionId.slice(0, 8)}: ${errMsg}`);

      const doneEvent: ParsedEvent = {
        type: "message_done",
        message: {
          id: uuidv4(),
          role: "assistant",
          content: "",
          toolUses: [],
          blocks: [],
          timestamp: Date.now(),
        },
      };

      try {
        this.opts.onEvents([doneEvent]);
      } catch {
        // best-effort
      }
      this.opts.onError(errMsg);
    }, 10_000);
  }

  private async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    this.opts.hookRouter.unregister(this.opts.sessionId);
    if (this.settingsPath) {
      await cleanupHookSettings(this.opts.sessionId).catch(() => {});
      this.settingsPath = null;
    }
  }
}
