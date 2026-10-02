import { v4 as uuidv4 } from "uuid";
import { isSandboxEscape, NETWORK_ACCESS_TOOL } from "@/lib/sandbox-requests";
import type { SandboxConfig } from "@/types";
import { sandboxEscapePossible } from "./claude-sandbox-rules";
import { cleanupHookSettings, prepareHookSettings } from "./claude-settings";
import { fetchCliInitData } from "./cli-init-fetch";
import { logDiag } from "./debug-logger";
import { ONE_M_CREDITS_REQUIRED, type ParsedEvent, TURN_CONTINUES } from "./event-parser";
import { newPermissionRequestId, translateHookEvent } from "./hook-event-translator";
import type { HookResponse, HookRouter, PermissionDecision, SessionHookHandler } from "./hook-router";
import { PtySession } from "./pty-session";
import { countTranscriptMessages, promptMatchKey, TranscriptPromptFollower, type TranscriptPrompts } from "./transcript";

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
  /** OS-level Bash sandbox written into the settings file when enabled. */
  sandbox?: SandboxConfig;
  /** Optional debug callback for raw PTY data chunks. */
  onPtyData?: (chunk: string) => void;
  /** The permission mode the spawn asked for (--permission-mode). Hook
   *  payloads report the mode the CLI is actually in, which need not be the
   *  one asked for; notePayloadMode passes it out for the UI to show. */
  expectedPermissionMode?: "manual" | "auto" | "plan";
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
/** How long a message typed mid-turn has to show up as the CLI's
 *  UserPromptSubmit. The CLI runs that hook the moment Enter queues the
 *  message, so this is far longer than it needs. */
const MID_TURN_CONFIRM_MS = 5000;
/** After a turn ends (or is interrupted) with a mid-turn message not yet seen
 *  taken up, how long to keep reading the transcript for what became of it.
 *  The CLI starts the turn for it within milliseconds, and writes the entries
 *  that say so a moment after the hooks around them. */
const HELD_TAKE_UP_MS = 5000;
const HELD_POLL_MS = 250;
const NETWORK_DIALOG_TITLE = "Network request outside of sandbox";

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class PtyRuntime {
  private readonly opts: PtyRuntimeOptions;
  private pty: PtySession | null = null;
  private settingsPath: string | null = null;
  /** Hook requests awaiting a decision, by request id. The tool name rides
   *  along so onNotification can tell whether a rendered dialog belongs to a
   *  request the user already has a card for. */
  private readonly pendingPermissions = new Map<string, { resolve: (decision: PermissionDecision) => void; toolName: string }>();
  /** Synthetic requests for TUI-only dialogs (see onNotification), by id:
   *  answered with keystrokes into the PTY, not through the hook response
   *  channel. A network dialog also carries the host it asks about. */
  private readonly pendingTuiDialogs = new Map<string, { kind: "permission" } | { kind: "network"; host?: string; command?: string }>();
  /** The permission mode the CLI last reported in a hook payload. */
  private cliPermissionMode: string | undefined;
  private lastPreToolUse: { tool: string; input?: Record<string, unknown> } | null = null;
  /**
   * Background work still running, by task id, taken from the CLI's own
   * `background_tasks` list rather than inferred from the Subagent hooks.
   *
   * SubagentStop is not "the agent finished". Measured against the real CLI:
   * SubagentStop fires ~90ms after SubagentStart, right after the parent's
   * message_done, while the SAME payload's background_tasks still reports the
   * agent running; the genuine completion arrives much later as a task list
   * that no longer contains it. Live, the opposite failure: the launched
   * agent's own stop never arrived at all, and stops turned up for ids that
   * never started (the CLI's internal agents report on the parent session). So
   * neither counting stops nor pairing their ids can track agent lifetime.
   * background_tasks can, and does — it is what the task cards already use.
   *
   * SubagentStart still adds optimistically, so the indicator appears the
   * moment an agent launches instead of waiting for the parent's Stop to carry
   * the first list.
   */
  private readonly runningTasks = new Set<string>();
  /**
   * Whether the parent's turn has ended (Stop seen, no new prompt yet).
   *
   * The status gate below applies only in that window. A subagent's PreToolUse
   * is indistinguishable from the main thread's — probed against the real CLI:
   * same session_id, same transcript_path, no agent id — and every PreToolUse
   * emits `__tool_use_start`, which drives the session to "running". That is
   * correct mid-turn and wrong once the turn has ended, where it restarted the
   * spinner on a session idle and waiting for the user. Keying the gate on the
   * turn boundary means a user who sends a new message while an agent is still
   * working still gets a spinner for their own turn.
   */
  private turnEnded = false;
  private exited = false;
  private cleaned = false;
  /** Resolver armed by a delivery attempt; fired when UserPromptSubmit confirms the prompt landed. */
  private promptAccepted: (() => void) | null = null;
  /** A user turn is under way: its prompt was accepted and its Stop has not
   *  come. While one is, the CLI takes a typed message into its own queue and
   *  hands it to the model with the next tool result (see sendMidTurnText). */
  private turnInProgress = false;
  /** Initial or live deliveries still confirming. While one is, the CLI is not
   *  yet known to be in a turn, and a UserPromptSubmit belongs to it. */
  private deliveriesInFlight = 0;
  /** Resolver armed by sendMidTurnText, fired with the UserPromptSubmit payload. */
  private midTurnAccepted: ((payload: Record<string, unknown>) => void) | null = null;
  /** Mid-turn sends still being typed or confirmed. */
  private midTurnTyping = 0;
  /**
   * Messages typed in mid-turn that the CLI has not taken up yet: each one's
   * promptMatchKey, when it was typed, and the prompt id of the turn it was
   * typed into (its UserPromptSubmit carries that turn's id, not one of its
   * own). The CLI takes one up either at the next tool result of that turn, or
   * as a turn of its own straight after the turn ends (or is interrupted).
   */
  private heldMidTurn: Array<{ key: string; at: number; promptId?: string }> = [];
  private heldWatch: ReturnType<typeof setTimeout> | null = null;
  /** Reads the transcript from just before the first held message was typed,
   *  for what became of each; `heldSeen` keeps what it found not yet matched. */
  private heldFollower: TranscriptPromptFollower | null = null;
  private heldSeen: TranscriptPrompts = { queued: [], absorbed: [], opened: [] };
  /** Mid-turn sends type one at a time: two at once would mix their keystrokes. */
  private midTurnChain: Promise<unknown> = Promise.resolve();
  /** Bumped by every send, and by interrupt/kill, so sendUserText's retry loop
   *  can tell its own delivery is still the current one. */
  private sendEpoch = 0;
  /** Bumped by interrupt() and kill(), which dismiss every dialog on screen, so
   *  a network request still being raised knows its dialog is gone. */
  private dialogEpoch = 0;
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
      sandbox: this.opts.sandbox,
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
        this.stopHeldWatch();
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
    // The REPL is up, so everything painted getting here is history — including
    // the trust dialog handleTrustDialog already answered. Left in the buffer it
    // reads as a live dialog to blockingDialogOnScreen for the whole window
    // before the first hook clears it, which refused the session's first message.
    this.ptyOutputBuffer = "";

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
    this.deliveriesInFlight++;
    try {
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
    } finally {
      this.deliveriesInFlight--;
    }
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
   * Deliver an interactive (live) user message, confirming a turn actually
   * started and retyping it if not.
   *
   * Typing into a TUI is blind: there is no ready signal and no ack, so the same
   * swallow deliverInitialPrompt guards against happens on live sends too, and
   * was measured happening on a real Mac (two `pty:user-send-no-turn` records in
   * one session, one right after an Esc dismissed an AskUserQuestion dialog).
   * The cost was worse here than at spawn, because nothing recovered: the
   * session hung "running" on a message the CLI never saw, the optimistic bubble
   * vanished on reload, and the only way out was interrupting and sending again
   * by hand. So this is now the same confirm-and-resend loop as the initial
   * prompt — which is exactly that manual workaround, done automatically.
   *
   * Resending cannot double-submit a message that was merely slow: sendText
   * opens with \x15 (kill-line), so a retype clears anything still sitting
   * unsubmitted in the input box before typing over it. And a submitted prompt
   * writes its user turn to the JSONL immediately, so the end-of-window
   * transcript check catches a landed message even when the hook is lost, and
   * returns rather than resending into it.
   */
  async sendUserText(text: string): Promise<void> {
    if (!this.pty) throw new Error("PtyRuntime not started");
    this.deliveriesInFlight++;
    try {
      await this.typeUserText(text);
    } finally {
      this.deliveriesInFlight--;
    }
  }

  private async typeUserText(text: string): Promise<void> {
    const { sessionId, cliSessionId, cwd } = this.opts;
    const MAX_ATTEMPTS = 3;
    // Shorter than the initial prompt's 8s: a live REPL that accepts input does
    // so within a few hundred ms, and three windows here add up to the 12s this
    // used to spend just watching the failure happen.
    const CONFIRM_MS = 4000;
    const baselineMsgs = countTranscriptMessages(cliSessionId, cwd);
    const turnStarted = () => countTranscriptMessages(cliSessionId, cwd) > baselineMsgs;
    // Interrupting or killing the session, or superseding this send with
    // another, invalidates the retry: keystrokes must not keep arriving at a
    // REPL the user has since taken somewhere else.
    const epoch = ++this.sendEpoch;
    logDiag(sessionId, "pty:user-send", { textLen: text.length, head: text.slice(0, 80), baselineMsgs, screenBefore: this.recentScreen() });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const pty = this.pty;
      if (this.exited || !pty || this.sendEpoch !== epoch) {
        logDiag(sessionId, "pty:user-send-abandoned", { attempt, exited: this.exited, superseded: this.sendEpoch !== epoch });
        return;
      }
      const dialog = this.blockingDialogOnScreen();
      if (dialog) {
        logDiag(sessionId, "pty:user-send-blocked-by-dialog", { attempt, dialog });
        console.log(`[pty-runtime] refusing to type into a CLI dialog for ${sessionId.slice(0, 8)}: ${dialog}`);
        this.emitApiError(
          dialog === NETWORK_DIALOG_TITLE
            ? "Your message was not sent. A sandboxed command is waiting on a network access request: answer its card, then send again."
            : `Your message was not sent. The CLI is waiting on a dialog that has to be answered in the terminal: "${dialog}". ` +
                "Stop the session to dismiss it, then send again.",
          { keepScreen: true },
        );
        return;
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const accepted = new Promise<boolean>((resolve) => {
        this.promptAccepted = () => resolve(true);
        timer = setTimeout(() => resolve(false), CONFIRM_MS);
      });
      const attemptAt = Date.now();
      await pty.sendText(text);
      const ok = await accepted;
      if (timer) clearTimeout(timer);
      this.promptAccepted = null;

      if (ok || turnStarted()) {
        logDiag(sessionId, "pty:user-send-confirmed", { attempt, waitedMs: Date.now() - attemptAt, viaHook: ok });
        return;
      }
      console.log(
        `[pty-runtime] user message produced NO turn after ${CONFIRM_MS}ms for ${sessionId.slice(0, 8)} (attempt ${attempt}/${MAX_ATTEMPTS}, textLen=${text.length}); input was swallowed by the REPL, resending.`,
      );
      logDiag(sessionId, "pty:user-send-no-turn", {
        attempt,
        waitedMs: Date.now() - attemptAt,
        baselineMsgs,
        head: text.slice(0, 80),
        screenAfter: this.recentScreen(),
      });
    }

    if (this.exited || this.sendEpoch !== epoch) return;
    // Every attempt was swallowed, so the message is provably not in the CLI.
    // Say so and force the turn idle: leaving it "running" is the hang this set
    // out to fix, and a stuck-running session also holds back its queue.
    logDiag(sessionId, "pty:user-send-failed", { attempts: MAX_ATTEMPTS });
    this.emitApiError(
      `Your message never reached Claude — it was typed in ${MAX_ATTEMPTS} times and the CLI never started a turn. Nothing was sent. Send it again; if that fails too, stop the session first.`,
    );
  }

  /**
   * Whether a message typed now would join the CLI's own queue for the turn
   * under way, which hands it to the model with the next tool result, or runs
   * it as a turn of its own once this one ends.
   *
   * Only while a turn is confirmed under way, and only into the input box: not
   * while a delivery is still confirming (its UserPromptSubmit would be taken
   * for this message's), and not while a permission or other dialog is waiting
   * on the user, since typed keys would answer it.
   */
  canTakeMidTurnMessage(): boolean {
    return (
      !!this.pty &&
      !this.exited &&
      this.turnInProgress &&
      this.deliveriesInFlight === 0 &&
      this.pendingPermissions.size === 0 &&
      this.pendingTuiDialogs.size === 0 &&
      this.blockingDialogOnScreen() === null
    );
  }

  /**
   * Type a message into the CLI while a turn is under way and leave it to the
   * CLI's queue. Resolves true once the CLI has queued it, false when the
   * message did not go in (it is then the caller's to send another way).
   *
   * Never retyped: a message the CLI queued but whose hook was lost would then
   * be queued twice. The transcript's enqueue record stands in for a lost hook.
   */
  sendMidTurnText(text: string): Promise<boolean> {
    const typed = this.midTurnChain.then(() => this.typeMidTurnText(text));
    this.midTurnChain = typed.catch(() => {});
    return typed;
  }

  private async typeMidTurnText(text: string): Promise<boolean> {
    const { sessionId, cliSessionId, cwd } = this.opts;
    const pty = this.pty;
    if (!pty || !this.canTakeMidTurnMessage()) {
      logDiag(sessionId, "pty:mid-turn-refused", { turnInProgress: this.turnInProgress, deliveries: this.deliveriesInFlight });
      return false;
    }
    // Started before typing, so it reads every entry the message leads to.
    this.heldFollower ??= new TranscriptPromptFollower(cliSessionId, cwd);
    this.midTurnTyping++;
    try {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const reported = new Promise<Record<string, unknown> | null>((resolve) => {
        this.midTurnAccepted = resolve;
        timer = setTimeout(() => resolve(null), MID_TURN_CONFIRM_MS);
      });
      const at = Date.now();
      logDiag(sessionId, "pty:mid-turn-send", { textLen: text.length, head: text.slice(0, 80), screenBefore: this.recentScreen() });
      await pty.sendText(text);
      const payload = await reported;
      if (timer) clearTimeout(timer);
      this.midTurnAccepted = null;
      const prompt = typeof payload?.prompt === "string" && payload.prompt ? payload.prompt : text;
      const key = promptMatchKey(prompt);
      this.readHeldFollower();
      if (!payload && !this.takeSeen("queued", key)) {
        logDiag(sessionId, "pty:mid-turn-unconfirmed", { waitedMs: Date.now() - at, screenAfter: this.recentScreen() });
        return false;
      }
      const promptId = typeof payload?.prompt_id === "string" ? payload.prompt_id : undefined;
      this.heldMidTurn.push({ key, at, promptId });
      logDiag(sessionId, "pty:mid-turn-queued", { waitedMs: Date.now() - at, viaHook: !!payload, held: this.heldMidTurn.length });
      return true;
    } finally {
      this.midTurnTyping--;
      this.releaseFollower();
    }
  }

  /** Whether messages typed mid-turn are still in the CLI's queue. After an
   *  interrupt, the CLI is starting a turn to take them up. */
  get holdsMidTurnMessages(): boolean {
    return this.heldMidTurn.length > 0;
  }

  /** Remove one `key` from what the follower has seen of `kind`. */
  private takeSeen(kind: keyof TranscriptPrompts, key: string): boolean {
    const i = this.heldSeen[kind].indexOf(key);
    if (i === -1) return false;
    this.heldSeen[kind].splice(i, 1);
    return true;
  }

  private readHeldFollower(): void {
    if (!this.heldFollower) return;
    const found = this.heldFollower.readNew();
    this.heldSeen.queued.push(...found.queued);
    this.heldSeen.absorbed.push(...found.absorbed);
    this.heldSeen.opened.push(...found.opened);
  }

  /** Stop following the transcript once nothing is held or being typed. */
  private releaseFollower(): void {
    if (this.heldMidTurn.length > 0 || this.midTurnTyping > 0) return;
    this.heldFollower = null;
    this.heldSeen = { queued: [], absorbed: [], opened: [] };
  }

  /**
   * Drop the held messages the transcript shows the CLI has taken up, and say
   * whether any of them opened a turn of their own (rather than being handed
   * over inside the turn they arrived in).
   */
  private reconcileHeld(): { opened: boolean } {
    if (this.heldMidTurn.length === 0) {
      this.releaseFollower();
      return { opened: false };
    }
    this.readHeldFollower();
    let openedTurn = false;
    this.heldMidTurn = this.heldMidTurn.filter((h) => {
      if (this.takeSeen("absorbed", h.key)) return false;
      if (!this.takeSeen("opened", h.key)) return true;
      openedTurn = true;
      return false;
    });
    this.releaseFollower();
    return { opened: openedTurn };
  }

  /**
   * Follow up a turn that ended (or was interrupted) with held messages not
   * yet seen taken up. Either the CLI opens a turn for them, and the session
   * carries on until that turn's Stop, or the transcript catches up to show
   * them handed over inside the turn that just ended, or nothing shows by the
   * deadline. In the last two no turn is coming, and the session goes idle
   * rather than spinning.
   */
  private watchHeldTakeUp(): void {
    this.stopHeldWatch();
    const armedAt = Date.now();
    const deadline = armedAt + HELD_TAKE_UP_MS;
    const check = () => {
      this.heldWatch = null;
      if (this.exited) return;
      if (this.reconcileHeld().opened) {
        // The CLI empties its queue into the one turn, so what was waiting
        // when this turn ended went with it. Anything typed since is new.
        this.heldMidTurn = this.heldMidTurn.filter((h) => h.at > armedAt);
        this.releaseFollower();
        logDiag(this.opts.sessionId, "pty:mid-turn-turn-opened", { held: this.heldMidTurn.length });
        return;
      }
      if (this.heldMidTurn.some((h) => h.at <= armedAt) && Date.now() < deadline) {
        this.heldWatch = setTimeout(check, HELD_POLL_MS);
        return;
      }
      // Typed since the turn ended, so into the CLI between turns, where it
      // opens a turn of its own: that one is still to be seen.
      this.heldMidTurn = this.heldMidTurn.filter((h) => h.at > armedAt);
      if (this.heldMidTurn.length > 0) {
        this.watchHeldTakeUp();
        return;
      }
      logDiag(this.opts.sessionId, "pty:mid-turn-no-turn");
      this.releaseFollower();
      this.turnInProgress = false;
      this.turnEnded = true;
      this.emit([
        {
          type: "message_done",
          message: { id: uuidv4(), role: "assistant", content: "", toolUses: [], blocks: [], timestamp: Date.now() },
        },
      ]);
    };
    this.heldWatch = setTimeout(check, HELD_POLL_MS);
  }

  private stopHeldWatch(): void {
    if (this.heldWatch) clearTimeout(this.heldWatch);
    this.heldWatch = null;
  }

  sendSlash(command: string): void {
    if (!this.pty) throw new Error("PtyRuntime not started");
    this.pty.sendSlash(command);
  }

  sendKey(key: string): void {
    if (!this.pty) throw new Error("PtyRuntime not started");
    this.pty.sendKey(key);
  }

  /**
   * Sends Esc to claude — the interactive REPL treats it as interrupt — and then
   * keeps pressing until nothing modal is left on screen (clearBlockingDialogs).
   */
  interrupt(): void {
    if (!this.pty) return;
    // Stop any in-flight delivery retry: the user asked for this turn to end, so
    // retyping the message they interrupted would restart it behind their back.
    this.sendEpoch++;
    this.dialogEpoch++;
    this.pty.sendKey("\x1b");
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve({ behavior: "deny", message: "interrupted" });
    }
    this.pendingPermissions.clear();
    // The Esc above dismissed any rendered TUI dialog with it.
    this.pendingTuiDialogs.clear();
    // Esc also makes the CLI take up what is waiting in its queue, at once, as
    // a turn of its own. That turn opens with no UserPromptSubmit (the hook ran
    // when the message was typed), so it is the one still in progress.
    this.stopHeldWatch();
    this.reconcileHeld();
    this.turnInProgress = this.heldMidTurn.length > 0;
    if (this.turnInProgress) {
      this.turnEnded = false;
      this.watchHeldTakeUp();
    }
    void this.clearBlockingDialogs();
  }

  /**
   * Press Esc until no dialog is left on screen, so stopping really does clear
   * the CLI.
   *
   * One Esc cancels one dialog. A multi-step wizard (the /auto-mode-setup case
   * in 04281d0) puts up the next step instead, and cockpit then refuses every
   * send with "the CLI is waiting on a dialog" while the user, whose session is
   * already idle, has nothing left to press.
   *
   * Each pass wipes the screen buffer first and waits for the repaint an Esc
   * always triggers, so the check reads the CURRENT screen. That wipe is what
   * makes this safe rather than blind: the buffer is append-only, so a dismissed
   * dialog's own footer is still in its tail and an unwiped check would press
   * again forever. Blind repeats are the thing to avoid here — a second Esc at
   * an idle REPL opens the CLI's own rewind picker, i.e. a loop that did not
   * look would toggle a dialog rather than clear one. Bounded, so a dialog that
   * ignores Esc costs three keystrokes and not a spin.
   */
  private async clearBlockingDialogs(): Promise<void> {
    const MAX_PASSES = 3;
    const REPAINT_MS = 400;
    // Named so the report can say WHICH dialog went, and so a stop that had
    // nothing to clear stays silent — the common case is stopping a live turn,
    // where the spinner stopping is already the feedback.
    let cleared: string | null = null;
    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      this.ptyOutputBuffer = "";
      await new Promise((resolve) => setTimeout(resolve, REPAINT_MS));
      if (this.exited || !this.pty) return;
      const dialog = this.blockingDialogOnScreen();
      if (!dialog) {
        if (cleared) {
          logDiag(this.opts.sessionId, "pty:dialog-clear-done", { passes: pass - 1, dialog: cleared });
          this.emit([{ type: "system_message", text: `Cleared the CLI's "${cleared}" dialog. Send your message again.` }]);
        }
        return;
      }
      cleared = dialog;
      logDiag(this.opts.sessionId, "pty:dialog-cleared", { pass, dialog });
      console.log(`[pty-runtime] clearing a CLI dialog for ${this.opts.sessionId.slice(0, 8)} (pass ${pass}): ${dialog}`);
      this.pty.sendKey("\x1b");
    }
    logDiag(this.opts.sessionId, "pty:dialog-clear-gave-up", { passes: MAX_PASSES, screen: this.recentScreen() });
    // Silence here would read as "stop did nothing", which is exactly what the
    // user sees anyway — say that Esc was refused so the terminal is the answer.
    this.emit([
      {
        type: "system_message",
        text: `The CLI is still showing its "${cleared}" dialog after ${MAX_PASSES} attempts to dismiss it. It has to be answered in the terminal.`,
      },
    ]);
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  async kill(signal?: string): Promise<void> {
    this.cancelErrorDebounce();
    this.sendEpoch++;
    this.dialogEpoch++;
    if (this.pty) {
      this.pty.kill(signal);
      this.pty = null;
    }
    // Resolve any in-flight permission promises so the bridge subprocess can exit.
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve({ behavior: "deny", message: "session ended" });
    }
    this.pendingPermissions.clear();
    this.pendingTuiDialogs.clear();
    // The process is going away, so nothing it launched is still running.
    this.runningTasks.clear();
    this.turnInProgress = false;
    this.heldMidTurn = [];
    this.stopHeldWatch();
    this.releaseFollower();
    await this.cleanup();
  }

  /**
   * Replace the running-task set from a payload's `background_tasks`, the CLI's
   * own account of what is still working. Payloads that carry it (Stop,
   * SubagentStop) are authoritative, including when the list is empty — an
   * empty list is how a finished agent is reported.
   */
  private syncRunningTasks(payload: Record<string, unknown>): void {
    const raw = payload.background_tasks;
    if (!Array.isArray(raw)) return;
    const running = new Set<string>();
    for (const entry of raw as { id?: unknown; status?: unknown }[]) {
      const id = stringOrEmpty(entry?.id);
      if (id && entry?.status === "running") running.add(id);
    }
    const before = this.runningTasks.size;
    this.runningTasks.clear();
    for (const id of running) this.runningTasks.add(id);
    this.reportRunningTasks(before);
  }

  /**
   * Report how much background work is running, so a session that is idle and
   * accepting input can still show that work it launched is going on. Emits
   * only when the count actually moved.
   */
  private reportRunningTasks(previous: number): void {
    if (this.runningTasks.size === previous) return;
    this.emit([{ type: "system_message", text: `__agents::${this.runningTasks.size}` }]);
  }

  /**
   * Record the permission mode a hook payload reports, which is the truth
   * about what governs the CLI's tool calls: it can differ from the mode the
   * spawn asked for, and the CLI changes it itself (plan mode, the auto
   * classifier's fallback to prompting). Every change is reported out as
   * `__cli_perm_mode::<mode>` so the UI shows what is really happening rather
   * than what was requested, and logged beside the expected mode, since a
   * mismatch is what explains a session behaving unlike its selector.
   */
  private notePayloadMode(payload: Record<string, unknown>, source: string): void {
    const actual = payload.permission_mode;
    if (typeof actual !== "string" || !actual || actual === this.cliPermissionMode) return;
    this.cliPermissionMode = actual;
    logDiag(this.opts.sessionId, "pty:cli-permission-mode", {
      mode: actual,
      expected: this.opts.expectedPermissionMode,
      source,
    });
    this.emit([{ type: "system_message", text: `__cli_perm_mode::${actual}` }]);
  }

  /** Called by SessionManager.respondToPermission when this session is on the
   *  pty runtime. `always` is the user's "don't ask again" choice. */
  notifyPermissionDecision(requestId: string, decision: PermissionDecision, opts?: { always?: boolean }): boolean {
    // A TUI-only dialog has no hook response channel — the CLI refused the
    // hook's allow (frontier models require interactive confirmation for
    // self-modifying writes), or the dialog is one the CLI never routes
    // through a hook (network access), and it is sitting on a rendered dialog.
    // The only way to answer is keystrokes into the PTY cockpit owns: "1"
    // selects the dialog's Yes option, Esc cancels it, and on the network
    // dialog "2" is its "Yes, and don't ask again for <host>".
    const dialog = this.pendingTuiDialogs.get(requestId);
    if (dialog) {
      if (!this.pty) {
        this.pendingTuiDialogs.delete(requestId);
        return false;
      }
      if (dialog.kind === "network" && !this.networkDialogShows(dialog.host)) {
        // Keystrokes answer whichever dialog is on screen, so an answer meant
        // for one host must not land on a dialog about another. A no needs no
        // keys: the host it refuses is not being asked about, so the card just
        // goes. A yes is raised again, to answer once the screen shows its host.
        if (decision.behavior !== "allow") {
          this.pendingTuiDialogs.delete(requestId);
          logDiag(this.opts.sessionId, "pty:network-dialog-deny-not-shown", { requestId, host: dialog.host ?? null });
          return true;
        }
        logDiag(this.opts.sessionId, "pty:network-dialog-host-mismatch", { requestId, host: dialog.host ?? null });
        this.emit([
          {
            type: "system_message",
            text: `Not allowing ${dialog.host}: the CLI is asking about a different host right now. Answer that request first.`,
          },
        ]);
        this.emitNetworkRequest(requestId, dialog.host, dialog.command);
        return false;
      }
      this.pendingTuiDialogs.delete(requestId);
      const key = decision.behavior !== "allow" ? "\x1b" : dialog.kind === "network" && opts?.always ? "2" : "1";
      logDiag(this.opts.sessionId, "pty:tui-dialog-decision", {
        requestId,
        kind: dialog.kind,
        behavior: decision.behavior,
        always: !!opts?.always,
      });
      this.pty.sendKey(key);
      // The answered dialog's frames are still in the append-only buffer, and
      // blockingDialogOnScreen would read them as a dialog still waiting.
      if (dialog.kind === "network") this.ptyOutputBuffer = "";
      return true;
    }
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      logDiag(this.opts.sessionId, "pty:permission-decision-unmatched", { requestId, behavior: decision.behavior });
      return false;
    }
    this.pendingPermissions.delete(requestId);
    logDiag(this.opts.sessionId, "pty:permission-decision", {
      requestId,
      behavior: decision.behavior,
      pending: this.pendingPermissions.size,
    });
    pending.resolve(decision);
    return true;
  }

  private buildHandler(): SessionHookHandler {
    return {
      onPreToolUse: async (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "unknown";
        const cliSession = typeof payload.session_id === "string" ? payload.session_id.slice(0, 8) : "none";
        const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id.slice(0, 12) : "none";
        logDiag(this.opts.sessionId, "hook:PreToolUse", { tool: toolName, toolUseId });
        console.log(`[pty-runtime] PreToolUse: tool=${toolName} cli_session=${cliSession} tool_use_id=${toolUseId}`);
        this.notePayloadMode(payload, "PreToolUse");
        // Remembered so a later TUI-only permission dialog (see onNotification)
        // can name the tool it is actually gating.
        this.lastPreToolUse = { tool: toolName, input: payload.tool_input as Record<string, unknown> | undefined };
        let events = translateHookEvent("PreToolUse", payload);
        if (this.turnEnded && this.runningTasks.size > 0) {
          // The turn is over and background work is still going, so this tool
          // call is that work's, not the user's turn resuming. Keep the tool
          // card, drop only the status signal (see turnEnded).
          events = events.filter((e) => !(e.type === "system_message" && e.text === "__tool_use_start"));
        }
        this.emit(events);
        return this.sandboxEscapeAsk(toolName, payload.tool_input);
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
      // Fires as the CLI starts (and on resume, /clear and compaction). It is
      // here for one thing: its payload carries the permission mode, so it is
      // known before any message is sent. Returns nothing, so no context is
      // added to the session.
      onSessionStart: (payload) => {
        this.notePayloadMode(payload, "SessionStart");
      },
      onStop: (payload) => {
        this.notePayloadMode(payload, "Stop");
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
        // The turn has ended: from here a tool call belongs to background work,
        // not the user's turn. The same payload carries the authoritative list
        // of what is still running.
        this.turnEnded = true;
        this.syncRunningTasks(payload);
        this.stopHeldWatch();
        // A message typed mid-turn that this turn never reached a tool result
        // for is still in the CLI's queue, and the CLI runs it as a turn of its
        // own straight away. Nothing announces that turn: its UserPromptSubmit
        // fired when the message was typed. So the session is not let go idle
        // while that is still possible (see watchHeldTakeUp).
        //
        // A Stop from a later turn than the one a message was typed into is
        // the end of the turn that took it up: the CLI empties its whole queue
        // into the next turn, and that turn has its own prompt id.
        const stopPromptId = typeof payload.prompt_id === "string" ? payload.prompt_id : undefined;
        if (stopPromptId) this.heldMidTurn = this.heldMidTurn.filter((h) => !h.promptId || h.promptId === stopPromptId);
        this.reconcileHeld();
        const continues = this.heldMidTurn.length > 0;
        this.turnInProgress = continues;
        logDiag(this.opts.sessionId, "pty:turn-ended", { runningTasks: this.runningTasks.size, heldMidTurn: this.heldMidTurn.length });
        const events = translateHookEvent("Stop", payload);
        if (continues) {
          this.turnEnded = false;
          events.push({ type: "system_message", text: TURN_CONTINUES });
          this.watchHeldTakeUp();
        }
        this.emit(events);
      },
      onStopFailure: (payload) => {
        const errorType = typeof payload.error_type === "string" ? payload.error_type : "unknown";
        const hookMessage = typeof payload.error_message === "string" ? payload.error_message : "";
        // The hook reports plenty of failures it has no words for: an upstream
        // 4xx relayed by the format proxy arrives as error_type "unknown" with
        // error_message "Unknown error", while the CLI has already printed the
        // provider's own sentence to the screen ("API Error: 400 This Go model
        // requires Global regions. Select Global in your workspace's Privacy
        // settings to use it." — measured live 2026-09-21, and the only text
        // that said what to actually do). Passing the payload through verbatim
        // surfaces "Unknown error (unknown)" and throws that away twice over,
        // since cancelling the debounce below also drops the scraped copy
        // scanForErrors was holding. So when the payload says nothing, read the
        // screen before clearing it.
        const screenError = hookMessage && hookMessage !== "Unknown error" ? null : this.apiErrorOnScreen();
        const errorMessage = screenError ?? (hookMessage || "Unknown error");
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        this.turnInProgress = false;
        this.heldMidTurn = [];
        this.stopHeldWatch();
        this.releaseFollower();
        logDiag(this.opts.sessionId, "hook:StopFailure", {
          errorType,
          errorMessage: errorMessage.slice(0, 200),
          fromScreen: !!screenError,
        });
        console.log(`[pty-runtime] StopFailure hook for session ${this.opts.sessionId.slice(0, 8)}: ${errorType} - ${errorMessage}`);
        this.emit(translateHookEvent("StopFailure", { ...payload, error_message: errorMessage }));
        // A scraped message already carries its own "(HTTP nnn)"; tacking the
        // hook's placeholder type onto it would only re-add the noise.
        this.opts.onError(screenError ?? `${errorMessage} (${errorType})`);
      },
      onUserPromptSubmit: (payload) => {
        this.cancelErrorDebounce();
        this.ptyOutputBuffer = "";
        logDiag(this.opts.sessionId, "pty:hook-user-prompt-submit", {
          armed: !!this.promptAccepted,
          runningTasks: this.runningTasks.size,
        });
        this.notePayloadMode(payload, "UserPromptSubmit");
        // A message typed while the turn was under way: the CLI has queued it
        // and the turn carries on, so nothing here starts a new one.
        if (this.midTurnAccepted) {
          this.midTurnAccepted(payload);
          this.midTurnAccepted = null;
          return;
        }
        this.promptAccepted?.();
        this.turnInProgress = true;
        // A parent turn is starting, so the gate closes: this turn's tool calls
        // are the user's, whatever background work is still going. The CLI
        // submits a prompt of its own when it resumes the parent after a
        // launched agent finishes, which is why this is also the signal that the
        // session is working again — a resumed turn that answers in text alone
        // makes no tool call, so `__tool_use_start` never arrives and the
        // session would sit idle while it typed.
        //
        // The running-task count is NOT cleared here. Background work outlives
        // the turn that launched it, and the user can send a message while it
        // runs; the next Stop re-syncs the truth either way.
        this.turnEnded = false;
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
        // Optimistic: the first authoritative list arrives with the parent's
        // Stop, and waiting for it would leave the indicator dark while an
        // agent was plainly launching.
        const startedAgent = stringOrEmpty(payload.agent_id);
        const beforeStart = this.runningTasks.size;
        if (startedAgent) this.runningTasks.add(startedAgent);
        this.reportRunningTasks(beforeStart);
        logDiag(this.opts.sessionId, "pty:subagent-start", { agentId: startedAgent || null, running: this.runningTasks.size });
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
        // The stop itself decides nothing: it fires ~90ms after the start while
        // this very payload's background_tasks still reports the agent running,
        // and stops also arrive for ids that never started here. Only the list
        // counts.
        this.syncRunningTasks(payload);
        logDiag(this.opts.sessionId, "pty:subagent-stop", {
          agentId: stringOrEmpty(payload.agent_id) || null,
          running: this.runningTasks.size,
          hadList: Array.isArray(payload.background_tasks),
        });
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
        if (/sandboxed command needs network access/i.test(message)) {
          void this.raiseNetworkAccessRequest();
          return;
        }
        if (/needs your permission/i.test(message)) {
          const tool = this.lastPreToolUse?.tool ?? "unknown";
          // The CLI notifies for a dialog it rendered itself AND for one it is
          // waiting on cockpit's hook response for. Rescuing the second kind
          // raises a second request for the same tool, and because it carries a
          // different id the client's per-id dedupe can't collapse it — the user
          // gets two identical cards (seen with AskUserQuestion). Worse, only the
          // hook request can actually be answered: a synthetic one is answered
          // with a "1" keystroke, which for a question card blind-selects the
          // first option. A still-pending hook request is proof the CLI has a
          // channel back, so leave that card alone. Once it has been answered,
          // a notification is the genuine article and gets rescued as before.
          if ([...this.pendingPermissions.values()].some((p) => p.toolName === tool)) {
            logDiag(this.opts.sessionId, "pty:tui-dialog-skipped-hook-pending", { tool });
            return;
          }
          const requestId = `tui-${newPermissionRequestId()}`;
          this.pendingTuiDialogs.set(requestId, { kind: "permission" });
          logDiag(this.opts.sessionId, "pty:tui-dialog-detected", { requestId, lastTool: this.lastPreToolUse?.tool ?? null });
          this.emit([
            {
              type: "permission_request",
              requestId,
              toolName: tool,
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

  /**
   * The CLI's network dialog ("Network request outside of sandbox") is drawn in
   * the terminal only: no PermissionRequest reaches cockpit, and the sandboxed
   * command's connection waits on it. It is raised here as a request whose
   * answer goes back as the dialog's own keys. Its host is read off the screen,
   * given a moment to paint, since the notification can arrive first.
   */
  private async raiseNetworkAccessRequest(): Promise<void> {
    const epoch = this.dialogEpoch;
    let host = this.networkDialogHost();
    for (let i = 0; !host && i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Stop dismissed the dialog while its host was being read: raising a
      // card now would ask about nothing, and block every send behind it.
      if (this.exited || this.dialogEpoch !== epoch) return;
      host = this.networkDialogHost();
    }
    // A repeat notification for a dialog that already has a card would give the
    // user two cards the client cannot merge. Only a host no pending card names
    // is a new request.
    const pending = [...this.pendingTuiDialogs.values()].filter((d) => d.kind === "network");
    if (pending.some((d) => !host || !d.host || d.host === host)) {
      logDiag(this.opts.sessionId, "pty:network-dialog-already-raised", { host: host ?? null });
      return;
    }
    const requestId = `tui-${newPermissionRequestId()}`;
    const lastCommand = this.lastPreToolUse?.tool === "Bash" ? this.lastPreToolUse.input?.command : undefined;
    const command = typeof lastCommand === "string" ? lastCommand : undefined;
    this.pendingTuiDialogs.set(requestId, { kind: "network", host, command });
    logDiag(this.opts.sessionId, "pty:network-dialog-detected", { requestId, host: host ?? null });
    this.emitNetworkRequest(requestId, host, command);
  }

  private emitNetworkRequest(requestId: string, host: string | undefined, command: string | undefined): void {
    const input: Record<string, unknown> = { ...(host ? { host } : {}), ...(command ? { command } : {}) };
    this.emit([
      {
        type: "permission_request",
        requestId,
        toolName: NETWORK_ACCESS_TOOL,
        toolInput: JSON.stringify(input),
        rawToolInput: input,
        interactiveOnly: true,
        // Carries the card's "always" choice back to notifyPermissionDecision.
        permissionSuggestions: [
          {
            type: "addRules",
            rules: [{ toolName: NETWORK_ACCESS_TOOL, ruleContent: host ?? "" }],
            behavior: "allow",
            destination: "localSettings",
          },
        ],
      },
    ]);
  }

  /**
   * The host the network dialog on screen asks about. The TUI repaints the
   * dialog in pieces, so a single frame can come out with characters missing;
   * over the frames in the buffer the true name is the most common reading.
   */
  private networkDialogHost(): string | undefined {
    const counts = new Map<string, number>();
    for (const m of this.recentScreen(4000).matchAll(/Host:\s*([A-Za-z0-9.*[\]:-]+)/g)) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    let best: string | undefined;
    for (const [host, n] of counts) {
      const bestN = best ? (counts.get(best) ?? 0) : 0;
      if (n > bestN || (n === bestN && best && host.length > best.length)) best = host;
    }
    return best;
  }

  /** Whether the screen is showing the network dialog for `host`. Unknown on
   *  either side counts as a match: only a readable, different host refuses. */
  private networkDialogShows(host: string | undefined): boolean {
    const onScreen = this.networkDialogHost();
    return !host || !onScreen || onScreen === host;
  }

  /**
   * A Bash call asking to leave the sandbox is answered "ask", which makes the
   * CLI raise a permission prompt for it in every mode, auto included, instead
   * of deciding it without one. The prompt arrives as an ordinary
   * PermissionRequest, and cockpit never auto-approves an escape. Calls that
   * cannot actually leave (no sandbox, or unsandboxed commands disallowed) get
   * no answer, so they are not held up by a prompt about nothing.
   */
  private async sandboxEscapeAsk(toolName: string, input: unknown): Promise<HookResponse | undefined> {
    if (toolName !== "Bash" || !isSandboxEscape(input)) return undefined;
    if (!(await sandboxEscapePossible(this.opts.cwd, this.opts.sandbox?.enabled === true))) return undefined;
    logDiag(this.opts.sessionId, "pty:sandbox-escape-ask", {});
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: "Runs outside the sandbox",
        },
      }),
      exitCode: 0,
    };
  }

  private handlePermissionRequest(payload: Record<string, unknown>): Promise<PermissionDecision> {
    const requestId = newPermissionRequestId();
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "unknown";
    const toolInput = payload.tool_input as Record<string, unknown> | undefined;
    // A PermissionRequest under an intended bypass is itself divergence — a
    // CLI genuinely in bypass mode never consults this hook.
    this.notePayloadMode(payload, "PermissionRequest");

    const event: ParsedEvent = {
      type: "permission_request",
      requestId,
      toolName,
      toolInput: toolInput ? JSON.stringify(toolInput) : "",
      rawToolInput: toolInput,
    };

    logDiag(this.opts.sessionId, "pty:permission-request", { requestId, toolName });
    return new Promise<PermissionDecision>((resolve) => {
      this.pendingPermissions.set(requestId, { resolve, toolName });
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
    const errMsg = this.apiErrorOnScreen();
    if (!errMsg) return;
    this.errorDebounce = setTimeout(() => this.emitApiError(errMsg), 10_000);
  }

  /**
   * The coded API error the CLI has printed to the screen, formatted for the
   * user, or null when there is none.
   *
   * Reads the same buffer scanForErrors accumulates, so it is also what a hook
   * consults when its own payload carries no usable message. The CLI prints the
   * upstream's sentence verbatim after the code, which for a proxied provider is
   * the only place that text appears at all.
   */
  private apiErrorOnScreen(): string | null {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal control chars
    const clean = this.ptyOutputBuffer.replace(ANSI_RE, "").replace(/[\x00-\x1f]/g, "");
    const match = clean.match(/API\s*Error:\s*(\d+)\s*([^✓✗❯]*)/) || clean.match(/APIError:\s*(\d+)\s*(.*)/);
    if (!match) return null;
    const detail = match[2].trim().slice(0, 200);
    return detail ? `${detail} (HTTP ${match[1]})` : `API Error (HTTP ${match[1]})`;
  }

  /**
   * A modal TUI dialog the CLI is waiting on, by title, or null.
   *
   * Cockpit types blind, so a dialog it cannot see eats the keystrokes: the
   * message never becomes a turn, and worse, the text drives the dialog. Caught
   * live (Mac, 2026-08-18) with the CLI's `/auto-mode-setup` wizard — the recorded
   * screens show a checkbox flipping from [ ] to [✔] between delivery attempts,
   * i.e. cockpit's own retry answering a consent dialog about scanning shell
   * history and other repositories on the user's behalf.
   *
   * The discriminator is an "Esc to cancel" AND an "Enter to <verb>" affordance
   * together, matched whitespace-blind because the TUI writes those footers a
   * character at a time with cursor moves in between, so the stripped screen has
   * no spaces left in them.
   *
   * "Esc to cancel" ALONE is not enough, though it looks like it should be: the
   * CLI puts it on its ordinary busy line too ("Accessing workspace… esc to
   * cancel"), and matching that refused every send while the CLI was merely
   * working — caught by tests/integration/turn-timing.spec.ts against the real
   * CLI, having shipped in 04281d0. Only something waiting on a decision offers
   * a way to commit one, so requiring the Enter half separates a dialog from a
   * spinner. The idle REPL footer has neither; it reads "auto mode on
   * (shift+tab to cycle) · ← for agents".
   *
   * The failure modes are not symmetric, which is why this errs strict: a false
   * negative costs a lost message (the pre-04281d0 behaviour), a false positive
   * blocks every message the session will ever send.
   */
  private blockingDialogOnScreen(): string | null {
    // The network dialog has neither footer phrase (it offers "(esc)"), and a
    // message typed into it would answer it: Enter picks "Yes". While one is
    // pending it blocks outright, until its card is answered or Stop clears it.
    if ([...this.pendingTuiDialogs.values()].some((d) => d.kind === "network")) return NETWORK_DIALOG_TITLE;
    const screen = this.recentScreen(1500);
    const flat = screen.replace(/\s+/g, "");
    // Without a pending request (Stop has just cleared them), the dialog is read
    // off the screen: its title and its question both, with no prompt footer
    // painted after them, since a reply merely quoting one of them is not it.
    const lower = flat.toLowerCase();
    const networkDialogAt = Math.min(lower.lastIndexOf("outsideofsandbox"), lower.lastIndexOf("allowthisconnection"));
    if (networkDialogAt >= 0 && !/(shift\+tabtocycle|forshortcuts)/i.test(flat.slice(networkDialogAt))) return NETWORK_DIALOG_TITLE;
    const lastFooter = flat.toLowerCase().lastIndexOf("esctocancel");
    if (lastFooter < 0 || !/enterto\w/i.test(flat)) return null;
    // A dialog that is still open is the last thing on screen. The REPL's own
    // idle footer painted after it means it has been answered and the prompt is
    // back — which is how a spawn's trust dialog, auto-answered seconds earlier,
    // otherwise reads as live.
    if (/shift\+tabtocycle/i.test(flat.slice(lastFooter))) return null;
    // The first line that is neither blank nor box-drawing is the dialog's
    // question — worth quoting back, since which dialog it is decides what the
    // user should do about it.
    const title = screen
      .split("\n")
      .map((line) => line.replace(/[─━│┌┐└┘]/g, "").trim())
      .find((line) => line.length > 3);
    return title ? title.slice(0, 120) : "an interactive prompt";
  }

  /** Force the turn idle and surface `errMsg`. Shared by the coded-error debounce and the 1M-credits path. */
  private emitApiError(errMsg: string, opts?: { keepScreen?: boolean }): void {
    this.errorDebounce = null;
    // A dialog the user has not dismissed is still on screen, and clearing the
    // buffer would blind the next send to it — which is how the keystrokes got
    // into it in the first place.
    if (!opts?.keepScreen) this.ptyOutputBuffer = "";

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
