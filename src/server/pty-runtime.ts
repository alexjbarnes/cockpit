import { v4 as uuidv4 } from "uuid";
import { cleanupHookSettings, prepareHookSettings } from "./claude-settings";
import { fetchCliInitData } from "./cli-init-fetch";
import { logDiag } from "./debug-logger";
import { ONE_M_CREDITS_REQUIRED, type ParsedEvent } from "./event-parser";
import { newPermissionRequestId, translateHookEvent } from "./hook-event-translator";
import type { HookRouter, PermissionDecision, SessionHookHandler } from "./hook-router";
import { PtySession } from "./pty-session";
import { countTranscriptMessages } from "./transcript";

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
  /** When false, the CLI spawns with thinking disabled (alwaysThinkingEnabled:false in the settings file). */
  thinkingEnabled?: boolean;
  /** Optional debug callback for raw PTY data chunks. */
  onPtyData?: (chunk: string) => void;
  /** The permission mode the spawn asked for (--permission-mode). Hook
   *  payloads report the CLI's ACTUAL mode; when an account/org policy
   *  silently discards a requested bypass, the two diverge and the runtime
   *  warns instead of letting the UI keep claiming bypass is active. */
  expectedPermissionMode?: "default" | "plan" | "bypassPermissions";
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
  /** Synthetic requests for TUI-only dialogs (see onNotification): answered
   *  with keystrokes into the PTY, not through the hook response channel. */
  private readonly pendingTuiDialogs = new Set<string>();
  private modeDivergenceWarned = false;
  private lastPreToolUse: { tool: string; input?: Record<string, unknown> } | null = null;
  private exited = false;
  private cleaned = false;
  /** Resolver armed by deliverInitialPrompt; fired when UserPromptSubmit confirms the first prompt landed. */
  private promptAccepted: (() => void) | null = null;
  private ptyOutputBuffer = "";
  private errorDebounce: ReturnType<typeof setTimeout> | null = null;
  /** Fire the 1M-credits error at most once per spawn. */
  private oneMCreditsHandled = false;

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
      thinkingEnabled: this.opts.thinkingEnabled,
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
    // A submitted prompt writes a user turn to the JSONL transcript. Growth past
    // this baseline proves the CLI accepted the prompt even when the
    // UserPromptSubmit hook never arrives — that hook is the only other
    // acceptance signal, and its loss used to fail an actively-working run (it
    // resent the 7KB prompt into a live turn, then killed the process). The
    // transcript is hook- and echo-independent, so we check it at the end of
    // each attempt's window before resending or failing.
    const baselineMsgs = countTranscriptMessages(this.opts.cliSessionId, this.opts.cwd);
    const turnStarted = () => countTranscriptMessages(this.opts.cliSessionId, this.opts.cwd) > baselineMsgs;
    logDiag(sessionId, "pty:deliver-begin", { textLen: text.length, maxAttempts: MAX_ATTEMPTS, baselineMsgs });
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
      logDiag(sessionId, "pty:deliver-attempt", { attempt, screenBefore: this.recentScreen() });
      await pty.sendText(text);
      const ok = await accepted;
      if (timer) clearTimeout(timer);
      this.promptAccepted = null;
      if (ok) {
        logDiag(sessionId, "pty:deliver-accepted", { attempt, waitedMs: Date.now() - attemptAt });
        return;
      }
      // The hook did not fire in this window. It can be lost even though the CLI
      // accepted the prompt and started working, so before resending or failing,
      // check whether a turn has actually started. If it has, the prompt landed;
      // do not resend into a live turn or kill a working run.
      if (turnStarted()) {
        logDiag(sessionId, "pty:deliver-accepted-via-transcript", { attempt, waitedMs: Date.now() - attemptAt });
        return;
      }
      logDiag(sessionId, "pty:deliver-timeout", { attempt, waitedMs: Date.now() - attemptAt, screenAfter: this.recentScreen() });
      console.log(
        `[pty-runtime] initial prompt not confirmed for ${sessionId.slice(0, 8)} (attempt ${attempt}/${MAX_ATTEMPTS}), resending`,
      );
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

  /**
   * Deliver an interactive (live) user message, then confirm a turn actually
   * started. Unlike the initial prompt, interactive sends were fire-and-forget:
   * sendMessage flips the session to "running" and types the keystrokes, but if
   * the REPL swallows them (no turn written) the session hangs "running" with the
   * bubble vanishing on reload and no diagnostic. This logs the outcome: a turn
   * started (transcript grew), or NO turn after the window — in which case it
   * captures the REPL screen so the stuck case is explainable from the logs.
   * Diagnostic only; it does not resend or change status.
   */
  async sendUserText(text: string): Promise<void> {
    if (!this.pty) throw new Error("PtyRuntime not started");
    const { sessionId, cliSessionId, cwd } = this.opts;
    const baselineMsgs = countTranscriptMessages(cliSessionId, cwd);
    logDiag(sessionId, "pty:user-send", { textLen: text.length, head: text.slice(0, 80), baselineMsgs, screenBefore: this.recentScreen() });
    await this.pty.sendText(text);

    const CONFIRM_MS = 12000;
    setTimeout(() => {
      if (this.exited) return;
      const nowMsgs = countTranscriptMessages(cliSessionId, cwd);
      if (nowMsgs > baselineMsgs) {
        logDiag(sessionId, "pty:user-send-confirmed", { waitedMs: CONFIRM_MS, baselineMsgs, nowMsgs });
        return;
      }
      // A submitted prompt writes a user turn to the JSONL at submit time, so no
      // growth in this window means the keystrokes never produced a turn — the
      // "sent but stuck, nothing happens, gone on reload" report. Surface it
      // unconditionally (matches the other [pty-runtime] logs the user watches),
      // and dump the REPL screen via the debug gate to show what swallowed it.
      console.log(
        `[pty-runtime] user message produced NO turn after ${CONFIRM_MS}ms for ${sessionId.slice(0, 8)} (textLen=${text.length}); input may have been swallowed by the REPL. Set COCKPIT_DEBUG=1 for the screen.`,
      );
      logDiag(sessionId, "pty:user-send-no-turn", {
        waitedMs: CONFIRM_MS,
        baselineMsgs,
        nowMsgs,
        head: text.slice(0, 80),
        screenAfter: this.recentScreen(),
      });
    }, CONFIRM_MS);
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
    // The Esc above dismissed any rendered TUI dialog with it.
    this.pendingTuiDialogs.clear();
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
    this.pendingTuiDialogs.clear();
    await this.cleanup();
  }

  /**
   * The CLI runs in a different permission mode than the spawn asked for —
   * seen live when an Anthropic account/org policy discards a requested
   * bypass ("Bypass permissions mode was disabled by settings"). Without this
   * warning the UI keeps showing bypass as on while every privileged action
   * silently raises prompts. Fires once per process.
   */
  private warnModeDivergence(actualMode: string, source: string): void {
    if (this.modeDivergenceWarned) return;
    this.modeDivergenceWarned = true;
    logDiag(this.opts.sessionId, "pty:permission-mode-divergence", {
      expected: this.opts.expectedPermissionMode,
      actual: actualMode,
      source,
    });
    this.emit([
      {
        type: "system_message",
        text:
          "⚠️ Bypass permissions is enabled for this session, but the CLI is actually running in " +
          `${actualMode} mode — bypass was disabled by your Anthropic account or organization policy. ` +
          "Permission prompts will appear, and some actions (like editing .claude skills) need explicit approval.",
      },
    ]);
  }

  /** Compare a hook payload's reported permission_mode against the spawn's request. */
  private checkPayloadMode(payload: Record<string, unknown>, source: string): void {
    if (this.opts.expectedPermissionMode !== "bypassPermissions") return;
    const actual = payload.permission_mode;
    if (typeof actual === "string" && actual !== "bypassPermissions") {
      this.warnModeDivergence(actual, source);
    }
  }

  /** Called by SessionManager.respondToPermission when this session is on the pty runtime. */
  notifyPermissionDecision(requestId: string, decision: PermissionDecision): boolean {
    // A TUI-only dialog has no hook response channel — the CLI refused the
    // hook's allow (frontier models require interactive confirmation for
    // self-modifying writes) and is sitting on a rendered dialog. The only
    // way to answer is keystrokes into the PTY cockpit owns: "1" selects the
    // dialog's Yes option, Esc cancels it.
    if (this.pendingTuiDialogs.has(requestId)) {
      this.pendingTuiDialogs.delete(requestId);
      logDiag(this.opts.sessionId, "pty:tui-dialog-decision", { requestId, behavior: decision.behavior });
      if (!this.pty) return false;
      this.pty.sendKey(decision.behavior === "allow" ? "1" : "\x1b");
      return true;
    }
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
        logDiag(this.opts.sessionId, "hook:PreToolUse", { tool: toolName, toolUseId });
        console.log(`[pty-runtime] PreToolUse: tool=${toolName} cli_session=${cliSession} tool_use_id=${toolUseId}`);
        this.checkPayloadMode(payload, "PreToolUse");
        // Remembered so a later TUI-only permission dialog (see onNotification)
        // can name the tool it is actually gating.
        this.lastPreToolUse = { tool: toolName, input: payload.tool_input as Record<string, unknown> | undefined };
        this.emit(translateHookEvent("PreToolUse", payload));
      },
      onPostToolUse: (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "unknown";
        const cliSession = typeof payload.session_id === "string" ? payload.session_id.slice(0, 8) : "none";
        const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id.slice(0, 12) : "none";
        logDiag(this.opts.sessionId, "hook:PostToolUse", { tool: toolName, toolUseId });
        console.log(`[pty-runtime] PostToolUse: tool=${toolName} cli_session=${cliSession} tool_use_id=${toolUseId}`);
        this.emit(translateHookEvent("PostToolUse", payload));
      },
      onStop: (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        const lastMsg = typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : "";
        // JOB-DEBUG: a Stop with an empty last_assistant_message is the exact
        // "went idle without an assistant message" failure signature. Capture it.
        logDiag(this.opts.sessionId, "hook:Stop", {
          lastMsgLen: lastMsg.length,
          lastMsgHead: lastMsg.slice(0, 160),
          stopHookActive: payload.stop_hook_active,
          payloadKeys: Object.keys(payload),
        });
        console.log(`[pty-runtime] Stop hook received for session ${this.opts.sessionId.slice(0, 8)}`);
        const events = translateHookEvent("Stop", payload);
        this.emit(events);
      },
      onStopFailure: (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        const errorType = typeof payload.error_type === "string" ? payload.error_type : "unknown";
        const errorMessage = typeof payload.error_message === "string" ? payload.error_message : "Unknown error";
        logDiag(this.opts.sessionId, "hook:StopFailure", { errorType, errorMessage: errorMessage.slice(0, 200) });
        console.log(`[pty-runtime] StopFailure hook for session ${this.opts.sessionId.slice(0, 8)}: ${errorType} - ${errorMessage}`);
        this.emit(translateHookEvent("StopFailure", payload));
        this.opts.onError(`${errorMessage} (${errorType})`);
      },
      onUserPromptSubmit: (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        logDiag(this.opts.sessionId, "pty:hook-user-prompt-submit", { armed: !!this.promptAccepted });
        this.checkPayloadMode(payload, "UserPromptSubmit");
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
        logDiag(this.opts.sessionId, "hook:PreCompact", { trigger: payload.trigger, payloadKeys: Object.keys(payload) });
        console.log(`[pty-runtime] PreCompact for session ${this.opts.sessionId.slice(0, 8)}`);
        this.emit(translateHookEvent("PreCompact", payload));
      },
      onPostCompact: (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        logDiag(this.opts.sessionId, "hook:PostCompact", { trigger: payload.trigger, payloadKeys: Object.keys(payload) });
        console.log(`[pty-runtime] PostCompact for session ${this.opts.sessionId.slice(0, 8)}`);
        this.emit(translateHookEvent("PostCompact", payload));
      },
      onNotification: (payload) => {
        this.cancelErrorDebounce();
        this.emit(translateHookEvent("Notification", payload));
        // "Claude needs your permission" arriving OUTSIDE the PermissionRequest
        // hook flow means the CLI rendered an interactive-only dialog — on
        // frontier models a hook allow does not satisfy self-modification
        // writes (.claude skills, dotfiles), and the session hangs invisibly.
        // Surface it as a real permission request; the decision comes back via
        // notifyPermissionDecision, which answers with PTY keystrokes.
        const message = typeof payload.message === "string" ? payload.message : "";
        if (/needs your permission/i.test(message)) {
          const requestId = `tui-${newPermissionRequestId()}`;
          this.pendingTuiDialogs.add(requestId);
          logDiag(this.opts.sessionId, "pty:tui-dialog-detected", { requestId, lastTool: this.lastPreToolUse?.tool ?? null });
          this.emit([
            {
              type: "permission_request",
              requestId,
              toolName: this.lastPreToolUse?.tool ?? "unknown",
              toolInput: this.lastPreToolUse?.input ? JSON.stringify(this.lastPreToolUse.input) : "",
              rawToolInput: this.lastPreToolUse?.input,
              interactiveOnly: true,
            },
          ]);
        }
      },
      onPermissionRequest: (payload) => this.handlePermissionRequest(payload),
    };
  }

  private handlePermissionRequest(payload: Record<string, unknown>): Promise<PermissionDecision> {
    const requestId = newPermissionRequestId();
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "unknown";
    const toolInput = payload.tool_input as Record<string, unknown> | undefined;
    // A PermissionRequest under an intended bypass is itself divergence — a
    // CLI genuinely in bypass mode never consults this hook.
    this.checkPayloadMode(payload, "PermissionRequest");

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

  /**
   * ANSI/control-stripped, whitespace-collapsed tail of the recent PTY output.
   * Debug aid for diagnosing why an initial prompt isn't accepted — shows what
   * the TUI is actually displaying (input box, a startup interstitial, a stuck
   * dialog) at the moment we type or time out.
   */
  private recentScreen(maxChars = 600): string {
    const clean = this.ptyOutputBuffer
      .replace(ANSI_RE, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal control chars
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
    return clean.length > maxChars ? clean.slice(-maxChars) : clean;
  }

  private scanForErrors(chunk: string): void {
    this.ptyOutputBuffer += chunk;
    if (this.ptyOutputBuffer.length > 8 * 1024) {
      this.ptyOutputBuffer = this.ptyOutputBuffer.slice(-4 * 1024);
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal control chars
    const clean = this.ptyOutputBuffer.replace(ANSI_RE, "").replace(/[\x00-\x1f]/g, "");

    // The CLI announces a policy-discarded bypass in its boot banner before
    // any hook fires — earliest possible detection of the divergence.
    if (
      !this.modeDivergenceWarned &&
      this.opts.expectedPermissionMode === "bypassPermissions" &&
      /Bypass permissions mode was disabled by settings/i.test(clean)
    ) {
      this.warnModeDivergence("default", "boot-banner");
    }

    // A 1M-context request on an account without usage credits (Sonnet 4.6):
    // the CLI prints this and the turn fails. It carries no HTTP code, so the
    // coded match below misses it, and it is genuinely fatal, so fire it
    // directly rather than through the hook-cancellable debounce — a trailing
    // Stop hook must not swallow it. Once per spawn.
    if (!this.oneMCreditsHandled && /Usage credits required for 1M context/i.test(clean)) {
      this.oneMCreditsHandled = true;
      this.emitApiError(ONE_M_CREDITS_REQUIRED);
      return;
    }

    if (this.errorDebounce) return;
    const match = clean.match(/API\s*Error:\s*(\d+)\s*([^✓✗❯]*)/) || clean.match(/APIError:\s*(\d+)\s*(.*)/);
    if (!match) return;

    const httpCode = match[1];
    const detail = match[2].trim().slice(0, 200);
    const errMsg = detail ? `${detail} (HTTP ${httpCode})` : `API Error (HTTP ${httpCode})`;
    this.errorDebounce = setTimeout(() => this.emitApiError(errMsg), 10_000);
  }

  /** Force the turn idle and surface `errMsg`. Shared by the coded-error debounce and the 1M-credits path. */
  private emitApiError(errMsg: string): void {
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
