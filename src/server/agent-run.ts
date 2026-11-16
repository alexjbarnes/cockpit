// One unattended agent session, from spawn to teardown: create the session,
// send it its prompt, answer its permission prompts, follow its tools and
// messages, wait out its background work, enforce its time limit, decide how
// it ended, and take the process down.
//
// A scheduled job's run and a workflow's run are both one of these.
// Everything that differs between them (what record is kept, who is told, what
// "finished" means beyond the turn ending) comes in through the spec.

import type { ContextSize } from "@/lib/models";
import type { JobRunToolUse, SandboxConfig, SessionInfo, SessionPermissionMode, ThinkingLevel } from "@/types";
import { logDiag } from "./debug-logger";
import { parseErrorBlock } from "./inbox";
import type { RunContext, WorkflowRunContext } from "./mcp/run-context";
import { INBOX_TOOL_NAME, isMcpToolAllowed, isToolAllowed } from "./run-permissions";
import type { SessionManager } from "./session-manager";
import type { SessionRuntime } from "./session-prefs";
import { countTranscriptMessages } from "./transcript";

export type AgentRunStatus = "running" | "success" | "failure" | "timeout" | "stopped";

/** What a run keeps about itself as it goes. A JobRun is one of these. */
export interface AgentRunRecord {
  id: string;
  sessionId: string;
  status: AgentRunStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
  toolsUsed: JobRunToolUse[];
  messageCount: number;
  cwd: string;
}

/** How a run's permission prompts are answered. */
export type AgentRunPermissions =
  /** Every prompt is allowed. */
  | { kind: "bypass" }
  /** Allowed when a rule or a listed server covers the tool, refused otherwise. */
  | { kind: "allowlist"; allowedTools: string[]; mcpToolFilters?: Record<string, string[]>; inboxTool: boolean }
  /** Left for a person to answer, through the session like any other. */
  | { kind: "ask" };

/** What an idle turn means to the run's owner. */
export type IdleVerdict =
  /** The owner sent the session something more; the run goes on. */
  | "wait"
  /** The run is over. A failure here overrides the turn's own success. */
  | { status: "success" | "failure"; error?: string };

export interface AgentRunSpec<R extends AgentRunRecord> {
  /** Label and fields carried on every diagnostic line, e.g. "job" and { jobId, runId }. */
  log: { prefix: string; fields: Record<string, unknown> };
  cwd: string;
  sessionName: string;
  /** What the session is sent. A function is told whether an earlier session
   *  was resumed, since one that remembers needs telling less. */
  prompt: string | ((resumed: boolean) => string);
  session: {
    bypassPermissions?: boolean;
    permissionMode?: SessionPermissionMode;
    sandbox: SandboxConfig;
    runtime?: SessionRuntime;
    runContext?: RunContext;
    workflowContext?: Omit<WorkflowRunContext, "sessionId">;
    runEnv?: Record<string, string>;
  };
  /** Carry on in this session, which an earlier run used, when it can still
   *  be brought back. Otherwise a new session is made as usual. */
  resumeSessionId?: string;
  model?: string;
  contextSize?: ContextSize;
  thinkingLevel?: ThinkingLevel;
  permissions: AgentRunPermissions;
  /** MCP servers the run may use. Every other server the CLI reports at start
   *  is turned off, except those in `keepServers`. */
  mcpServers: string[];
  /** Servers never turned off, whatever `mcpServers` says. */
  keepServers?: string[];
  maxDurationMinutes: number;
  /** Build the run's record once its session exists. */
  record: (session: SessionInfo) => R;
  save: (record: R) => void;
  /** The record is saved and the session is about to be sent its prompt.
   *  `settle` ends the run from outside, for an owner that stops it itself:
   *  it must have marked the record stopped and destroyed the session first. */
  started?: (record: R, settle: (record: R) => void) => void;
  /** A turn ended with nothing running in the background. Absent: the run is over. */
  idle?: (record: R) => IdleVerdict;
  /** The run ended and its record is saved; the session is still up. For alerts. */
  ended?: (record: R) => void;
  /** The session is gone. Last call, for releasing what the owner held. */
  released?: (record: R) => void;
  /** The owner stopped the run itself and the runner has let go. */
  stopped?: (record: R) => void;
}

/**
 * Start a run. Returns once the prompt is sent; `done` settles when the run is
 * over, with the record in its final state.
 */
export function startAgentRun<R extends AgentRunRecord>(
  sessionManager: SessionManager,
  spec: AgentRunSpec<R>,
): { record: R; done: Promise<R> } {
  const resumed = spec.resumeSessionId
    ? sessionManager.resumeForRun(spec.resumeSessionId, spec.cwd, {
        workflowContext: spec.session.workflowContext,
        runEnv: spec.session.runEnv,
      })
    : undefined;
  const sessionInfo = resumed ?? sessionManager.createSession(spec.cwd, spec.sessionName, spec.session);
  const sessionId = sessionInfo.id;
  // The stream runtime (`claude -p`) ends its process with the turn, so no
  // later idle can be woken by a task notification. Waiting would only
  // stretch a dead run to the watchdog, so that path keeps failing fast.
  const canWaitForBackground = sessionInfo.runtime !== "stream";
  const jlog = (label: string, data?: Record<string, unknown>) =>
    logDiag(sessionId, `${spec.log.prefix}:${label}`, { ...spec.log.fields, ...data });
  jlog(resumed ? "session-resumed" : "session-created", { cwd: spec.cwd, runtime: sessionInfo.runtime });

  const run = spec.record(sessionInfo);
  spec.save(run);

  let settle: (record: R) => void = () => {};
  const done = new Promise<R>((resolve) => {
    settle = resolve;
  });
  spec.started?.(run, settle);

  const toolTracker = new Map<string, JobRunToolUse>();
  let lastAssistantText = "";
  const enabledServers = new Set(spec.mcpServers);
  const keptServers = new Set(spec.keepServers ?? []);
  // Background subagents outlive the turn that launched them. If the turn
  // ends with any still running, the model was waiting for a notification
  // that nothing here will deliver, and cleanup is about to kill the PTY.
  const pendingTasks = new Set<string>();
  const permissions = spec.permissions;

  const unsubEvent = sessionManager.subscribe(sessionId, (event) => {
    if (event.type === "tool_use_start" && event.toolId) {
      toolTracker.set(event.toolId, {
        name: event.toolName || "unknown",
        input: event.toolInput || "",
        output: "",
        timestamp: Date.now(),
      });
      jlog("tool-start", { toolId: event.toolId, toolName: event.toolName ?? "unknown" });
    } else if (event.type === "tool_result" && event.toolId) {
      const entry = toolTracker.get(event.toolId);
      if (entry) {
        entry.output = event.toolOutput || "";
        entry.durationMs = Date.now() - entry.timestamp;
        run.toolsUsed.push(entry);
        toolTracker.delete(event.toolId);
        jlog("tool-result", { toolId: event.toolId, name: entry.name, durationMs: entry.durationMs, outputLen: entry.output.length });
      }
    } else if (event.type === "message_done") {
      run.messageCount++;
      let textLen = 0;
      if (event.message) {
        let text = event.message.content;
        if (!text && event.message.blocks) {
          text = event.message.blocks
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("\n");
        }
        if (text) {
          lastAssistantText = text;
          textLen = text.length;
        }
      }
      // A message_done carrying tool uses but no text is the turn that ends
      // after a tool_use without a final answer — the failure signature.
      jlog("message-done", {
        count: run.messageCount,
        textLen,
        toolUses: event.message?.toolUses?.length ?? 0,
        updatedLastText: textLen > 0,
      });
    } else if (event.type === "task_update" && event.taskInfo?.taskId) {
      const { taskId, status } = event.taskInfo;
      // "progress" is an activity line on a task that is still running, not
      // a completion; removing it here let a progressing agent look finished.
      if (status === "running" || status === "progress") pendingTasks.add(taskId);
      else pendingTasks.delete(taskId);
      jlog("task-update", { taskId, status, pending: pendingTasks.size });
    } else if (event.type === "task_sync") {
      // The CLI's whole background_tasks list, attached to Stop and
      // SubagentStop. It is authoritative: individual task updates can be
      // missed, and an empty list is how completion is reported.
      pendingTasks.clear();
      for (const task of event.tasks ?? []) {
        if (task.status === "running") pendingTasks.add(task.taskId);
      }
      jlog("task-sync", { tasks: (event.tasks ?? []).map((t) => ({ taskId: t.taskId, status: t.status })), pending: pendingTasks.size });
    } else if (event.type === "permission_request" && event.requestId) {
      if (permissions.kind === "ask") {
        // A person answers, through the session's own card, banner or push.
        jlog("permission", { toolName: event.toolName ?? "unknown", requestId: event.requestId, ask: true });
      } else if (permissions.kind === "bypass") {
        jlog("permission", { toolName: event.toolName ?? "unknown", requestId: event.requestId, bypass: true, allowed: true });
        sessionManager.respondToPermission(sessionId, event.requestId, true, event.rawToolInput, undefined, undefined, "bypass");
      } else {
        const toolName = event.toolName || "unknown";
        const inputStr = event.toolInput || "";
        // The inbox tool is cockpit's own reporting channel, not something the
        // user configures per run, so it bypasses the mcpServers allowlist it
        // would otherwise fail. The MCP server still confines a run token to
        // this one tool, so allowing it here grants nothing else.
        const isInboxTool = toolName === INBOX_TOOL_NAME;
        // An MCP tool passes on either gate: the mcpServers/mcpToolFilters
        // allowlist, or an allowedTools entry naming it outright. It used to
        // be the server gate alone — isMcpToolAllowed returns null only for
        // non-MCP names, so a boolean always short-circuited allowedTools —
        // while the job editor accepted "mcp__server__tool" entries and the
        // run's own prompt listed them, so those entries silently did
        // nothing. OR, not AND, so a run configured with only mcpServers is
        // unaffected. The inbox tool keeps its own gate: it is cockpit's
        // reporting channel, governed by inboxOutput rather than either list.
        const mcpResult = isInboxTool
          ? permissions.inboxTool
          : isMcpToolAllowed(toolName, inputStr, enabledServers, permissions.mcpToolFilters);
        const allowed = isInboxTool
          ? mcpResult === true
          : mcpResult === true || isToolAllowed(toolName, inputStr, permissions.allowedTools);
        jlog("permission", {
          toolName,
          requestId: event.requestId,
          mcpResult,
          allowed,
          enabledServers: [...enabledServers],
        });
        sessionManager.respondToPermission(
          sessionId,
          event.requestId,
          allowed,
          allowed ? (event.rawToolInput ?? {}) : undefined,
          undefined,
          undefined,
          "cockpit",
        );

        const permEntry: JobRunToolUse = {
          name: toolName,
          input: inputStr,
          output: "",
          timestamp: Date.now(),
          permitted: allowed,
        };
        run.toolsUsed.push(permEntry);
      }
    }
  });

  // Compaction is tracked from the system-message stream and every system
  // message the run receives is logged, so a teardown can be correlated with
  // a compaction window.
  let compacting = false;
  let lastCompactAt = 0;
  const unsubSystem = sessionManager.onSystem(sessionId, (text) => {
    if (text === "__compact::start") compacting = true;
    else if (text === "__compact::done") {
      compacting = false;
      lastCompactAt = Date.now();
    }
    jlog("system-msg", { text: text.slice(0, 140), compacting });
  });

  const initCleanup = sessionManager.onInit(sessionId, (initData) => {
    const disabling: string[] = [];
    for (const server of initData.mcpServers) {
      if (!enabledServers.has(server.name) && !keptServers.has(server.name)) {
        disabling.push(server.name);
        sessionManager.mcpToggle(sessionId, server.name, false).catch(() => {});
      }
    }
    jlog("init", { available: initData.mcpServers.map((s) => s.name), disabling, enabled: [...enabledServers] });
  });

  if (spec.model) {
    sessionManager.setModel(sessionId, spec.model, spec.contextSize);
    jlog("set-model", { model: spec.model, contextSize: spec.contextSize });
  }
  if (spec.thinkingLevel) {
    sessionManager.setThinkingLevel(sessionId, spec.thinkingLevel);
    jlog("set-thinking", { thinkingLevel: spec.thinkingLevel });
  }

  const maxMs = spec.maxDurationMinutes * 60 * 1000;
  const sentAt = Date.now();
  let sawRunning = false;
  let statusEvents = 0;

  const timeout = setTimeout(() => {
    jlog("watchdog-fired", {
      maxMs,
      elapsedMs: Date.now() - sentAt,
      sawRunning,
      messageCount: run.messageCount,
      toolCount: run.toolsUsed.length,
    });
    cleanup("timeout");
  }, maxMs);

  const unsubStatus = sessionManager.onStatus(sessionId, (status) => {
    statusEvents++;
    if (status === "running") sawRunning = true;
    // An "idle" that arrives while the process is still alive is the orphan
    // signature: the run gets marked done but the PTY keeps going untracked.
    const processAlive = sessionManager.hasRunningProcess(sessionId);
    jlog("status-event", {
      status,
      n: statusEvents,
      elapsedMs: Date.now() - sentAt,
      sawRunning,
      processAlive,
      // State that determines whether this idle is real or spurious.
      compacting,
      msSinceCompact: lastCompactAt ? Date.now() - lastCompactAt : null,
      lastAssistantTextLen: lastAssistantText.length,
      pendingTasks: pendingTasks.size,
      messageCount: run.messageCount,
      toolCount: run.toolsUsed.length,
    });
    if (status === "idle") {
      // This is the exact decision that ends the run. If the CLI is still
      // alive, or we just compacted, or there is no assistant text, this
      // idle is the prime suspect for a premature teardown.
      jlog("idle-cleanup-decision", {
        processAlive,
        compacting,
        msSinceCompact: lastCompactAt ? Date.now() - lastCompactAt : null,
        lastAssistantTextLen: lastAssistantText.length,
        lastAssistantTextHead: lastAssistantText.slice(0, 160),
        pendingTasks: pendingTasks.size,
        elapsedMs: Date.now() - sentAt,
      });
      // A background agent outlives the turn that launched it. The CLI
      // wakes the model with a task notification when it reports, which
      // starts another turn and ends in another idle; tearing the PTY down
      // here would kill the agent instead.
      if (canWaitForBackground && pendingTasks.size > 0) {
        jlog("waiting-on-background", {
          pending: pendingTasks.size,
          taskIds: [...pendingTasks],
          elapsedMs: Date.now() - sentAt,
        });
        return;
      }
      const verdict = spec.idle?.(run) ?? { status: "success" as const };
      if (verdict === "wait") {
        jlog("idle-owner-waits", { elapsedMs: Date.now() - sentAt });
        return;
      }
      if (verdict.status === "failure") run.error = verdict.error ?? run.error;
      cleanup(verdict.status);
    }
  });

  const unsubError = sessionManager.onError(sessionId, (error) => {
    jlog("error-event", { error, elapsedMs: Date.now() - sentAt });
    run.error = error;
    cleanup("failure");
  });

  let cleaned = false;
  function cleanup(finalStatus: "success" | "failure" | "timeout"): void {
    if (cleaned) {
      jlog("cleanup-skipped", { requestedStatus: finalStatus, elapsedMs: Date.now() - sentAt });
      return;
    }
    if (run.status === "stopped") {
      cleaned = true;
      jlog("cleanup-guard-stopped", { elapsedMs: Date.now() - sentAt });
      clearTimeout(timeout);
      settle(run);
      spec.stopped?.(run);
      return;
    }
    cleaned = true;
    jlog("cleanup-begin", {
      finalStatus,
      elapsedMs: Date.now() - sentAt,
      sawRunning,
      statusEvents,
      messageCount: run.messageCount,
      toolCount: run.toolsUsed.length,
      lastTextLen: lastAssistantText.length,
    });
    clearTimeout(timeout);
    unsubEvent?.();
    unsubStatus?.();
    unsubError?.();
    unsubSystem?.();
    initCleanup?.();

    run.completedAt = Date.now();
    run.durationMs = run.completedAt - run.startedAt;
    if (finalStatus === "timeout") {
      run.error =
        pendingTasks.size > 0
          ? `Exceeded max duration of ${spec.maxDurationMinutes} minutes while ${pendingTasks.size} background task(s) still ran`
          : `Exceeded max duration of ${spec.maxDurationMinutes} minutes`;
      sessionManager.destroySession(sessionId);
    }

    if (finalStatus === "success" && lastAssistantText) {
      const errorBlock = parseErrorBlock(lastAssistantText);
      if (errorBlock) {
        finalStatus = "failure";
        run.error = errorBlock.details ? `${errorBlock.error}: ${errorBlock.details}` : errorBlock.error;
        jlog("error-block-detected", { error: run.error });
      }
    }

    // A completed turn always ends with an assistant message. Reaching idle
    // without one means the turn was cut short rather than finished — the
    // signature of a run torn down mid-compaction, which reported "success"
    // for three days while producing nothing. Fail loudly instead.
    if (finalStatus === "success" && !lastAssistantText) {
      finalStatus = "failure";
      run.error = "Job went idle without producing any assistant message, so the turn never completed";
      jlog("no-assistant-message", { toolCount: run.toolsUsed.length });
    }

    // A PTY run that is still waiting here ended for another reason
    // (stopped or timeout), so the wait branch above already covers it.
    // Only the stream runtime, which cannot come back, fails on pending
    // work at the first idle.
    if (finalStatus === "success" && !canWaitForBackground && pendingTasks.size > 0) {
      finalStatus = "failure";
      run.error = `Job ended its turn with ${pendingTasks.size} background task(s) still running, so their work was never collected`;
      jlog("pending-background-tasks", { pending: pendingTasks.size });
    }

    run.status = finalStatus;

    const transcriptCount = countTranscriptMessages(sessionId, spec.cwd);
    jlog("transcript-count", { transcriptCount, runMessageCount: run.messageCount });
    if (transcriptCount > run.messageCount) run.messageCount = transcriptCount;

    spec.save(run);
    spec.ended?.(run);

    jlog("cleanup-done", {
      finalStatus,
      durationMs: run.durationMs,
      messageCount: run.messageCount,
      toolCount: run.toolsUsed.length,
      error: run.error,
    });

    // A one-shot run's PTY claude sits idle at the prompt after answering;
    // without this it never exits and leaks ~310MB per run until the next
    // server restart. Idempotent — a timeout already destroyed it above.
    sessionManager.destroySession(sessionId);

    spec.released?.(run);
    settle(run);
  }

  const prompt = typeof spec.prompt === "function" ? spec.prompt(!!resumed) : spec.prompt;
  jlog("send-message", { promptLen: prompt.length, maxMs });
  sessionManager.sendMessage(sessionId, prompt);

  return { record: run, done };
}
