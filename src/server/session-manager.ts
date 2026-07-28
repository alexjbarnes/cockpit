import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { classifyCliCommand } from "@/lib/cli-commands";
import { describeJobTargets } from "@/lib/job-target-label";
import {
  allowedEffortLevels,
  type ContextSize,
  cliModelWithContext,
  coerceEffort,
  contextSizeToWindow,
  DEFAULT_CONTEXT_SIZE,
  modelOneMRequiresCredits,
  recommendedEffort,
  resolveModel,
} from "@/lib/models";
import { getAssistantSettings, updateAssistantSettings } from "@/server/assistant-settings";
import { getCockpitDir } from "@/server/paths";
import { ensureCatalogFresh, OPENROUTER_PROVIDER_ID } from "@/server/provider-catalog";
import { getProvider, isBuiltinCatalogProvider, openRouterModelEnv, resolveProviderModel } from "@/server/providers";
import type {
  ChatMessage,
  ContentBlock,
  ContextUsage,
  DocumentAttachment,
  ImageAttachment,
  InitData,
  ModelSlots,
  SessionInfo,
  ThinkingLevel,
  TodoItem,
  ToolUse,
} from "@/types";
import { debugLog, isDebugEnabled, logDiag, logRawLine } from "./debug-logger";
import { getDefaults } from "./defaults";
import { ONE_M_CREDITS_REQUIRED, type ParsedEvent } from "./event-parser";
import { getHarnessAdapter } from "./harness/registry";
import type { HarnessProcess, HarnessProcessCallbacks, HarnessSpawnConfig } from "./harness/types";
import { getJob } from "./job-storage";
import { COCKPIT_AGENT_SYSTEM_PROMPT } from "./mcp/cockpit-agent-prompt";
import { clearToken, type RunContext, registerAuthToken, registerRunContext } from "./mcp/run-context";
import { findLatestPlanFile, readPlanFile } from "./plans";
import { findChainForCliSession, getSessionPrefs, type SessionRuntime, setSessionPrefs } from "./session-prefs";
import { getCockpitMcp } from "./singleton";
import { createStreamState, processEvents, type StreamState } from "./stream-processor";
import { TodoWatcher } from "./todo-watcher";
import { findSessionCwd, loadMoreMessages, loadPromptHistory, loadTranscript, transcriptExists } from "./transcript";

export type { SessionRuntime };

/**
 * Runtime for sessions that don't pick one.
 *
 * PTY is the supported path. Stream runs the CLI under `-p`, which the headless
 * docs say will default to `--bare` in a future release, and bare mode skips
 * OAuth and keychain reads, so it would stop authenticating against a
 * subscription. Stream stays selectable but is no longer the default.
 */
const DEFAULT_RUNTIME: SessionRuntime = "pty";

const smLog = (sessionId: string, msg: string) => {
  if (!isDebugEnabled()) return;
  const ts = new Date().toISOString().slice(11, 23);
  const short = sessionId.slice(0, 8);
  console.log(`[session:${short}] ${ts} ${msg}`);
};

export interface SessionEvents {
  event: [sessionId: string, event: ParsedEvent];
  status: [sessionId: string, status: "idle" | "running"];
  error: [sessionId: string, error: string];
  pending: [sessionId: string, count: number];
}

export interface PendingRequest {
  type: "permission" | "question";
  requestId: string;
  toolName: string;
  toolInput: string;
  rawToolInput?: Record<string, unknown>;
  permissionSuggestions?: Record<string, unknown>[];
  planFilePath?: string;
  planContent?: string;
  configProposal?: { toolName: string; domain: string; action: string; displayName?: string };
}

export interface StreamingSnapshot {
  messageId: string;
  content: string;
  toolUses: ToolUse[];
  blocks: ContentBlock[];
}

interface QueuedMessage {
  id: string;
  text: string;
  images?: ImageAttachment[];
  documents?: DocumentAttachment[];
}

interface Session {
  info: SessionInfo;
  harnessProcess: HarnessProcess | null;
  emitter: EventEmitter;
  cliSessionId: string;
  previousCliSessionIds: string[];
  bypassAllPermissions: boolean;
  planMode: boolean;
  pendingPlanReminder?: boolean;
  needsRespawnForPermissions: boolean;
  compacting: boolean;
  thinkingLevel: ThinkingLevel;
  streamState: StreamState | null;
  contextUsage: ContextUsage | null;
  contextWindowSize: number;
  todoItems: TodoItem[];
  initData?: InitData;
  pendingRequests: Map<string, PendingRequest>;
  streamingSnapshot: StreamingSnapshot | null;
  queuedMessages: QueuedMessage[];
  queuePaused: boolean;
  modelSlots: ModelSlots;
  transcriptBuffer: ChatMessage[];
  transcriptByteOffset: number;
  transcriptTotalSize: number;
  bufferCliSessionId: string;
  /** Pagination-only copy of previousCliSessionIds, consumed by getMoreHistory
   *  without affecting the canonical list used for stitching on reconnect. */
  paginationPrevIds: string[];
  /** "stream" spawns `claude -p` (current default). "pty" spawns interactive
   *  claude through node-pty + hooks. Selectable per session via env at
   *  creation time; future revisions may expose this on SessionInfo. */
  runtime: SessionRuntime;
  cockpitAgent: boolean;
  cockpitAgentCleanups: (() => void)[];
  mcpToken?: string;
  runContext?: RunContext;
  /** True while a spawn's async startup is in flight: set immediately before
   *  calling the harness adapter's spawn() and cleared when its `ready`
   *  promise resolves, rejects, or the process exits. Gates ensureProcess so a
   *  reconnect or startup race cannot spawn a duplicate CLI for the same
   *  session (the handle is assigned before harnessProcess.isAlive is
   *  necessarily true — true synchronously for the stream transport, but not
   *  until PTY's async start() resolves). Also read by the stale-check log to
   *  tell "process died" from "still spawning". */
  spawning?: boolean;
  todoWatcher: TodoWatcher | null;
  /** Cumulative token counts for the current session (used by /cost). */
  totalTokens: { input: number; output: number; cacheCreate: number; cacheRead: number };
}

export function buildMcpConfigArg(url: string, token: string): { path: string } {
  const dir = path.join(tmpdir(), "cockpit-mcp-config");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${token.slice(0, 16)}.json`);
  const config = {
    mcpServers: {
      "cockpit-config": {
        type: "http",
        url: `${url}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
  writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { path: filePath };
}

/**
 * Tools the cockpit assistant may use, but only after a human approves the
 * individual call. They skip the assistant's own allow/deny gate and land on the
 * ordinary permission prompt, so the URL or job being read is on screen first.
 * These are also the only assistant tools "Bypass tool prompts" covers: config
 * writes keep their approval card either way.
 *
 * WebFetch is the assistant's only egress. Everything else it can reach is
 * local, which is what stops content it reads from walking back out through a
 * URL. get_job_transcript returns arbitrary job output rather than cockpit's own
 * structured config, so unlike the other reads its payload is unbounded.
 */
const AGENT_PROMPTED_TOOLS = new Set(["WebFetch", "mcp__cockpit-config__get_job_transcript"]);

export class SessionManager {
  private sessions = new Map<string, Session>();
  private _cockpitAgentSessionPromise: Promise<string> | null = null;
  /**
   * Injectable so a test can state which transport it exercises instead of
   * inheriting whatever the product default happens to be. The stream-protocol
   * tests mock node:child_process, which the PTY path never touches, so they
   * would silently stop testing anything if the default moved under them.
   */
  private readonly defaultRuntime: SessionRuntime;

  constructor(opts?: { defaultRuntime?: SessionRuntime }) {
    this.defaultRuntime = opts?.defaultRuntime ?? DEFAULT_RUNTIME;
    // Periodically check for sessions stuck in "running" with a dead process
    setInterval(() => {
      for (const [id, session] of this.sessions) {
        if (session.info.status === "running" && !session.harnessProcess?.isAlive) {
          const short = id.slice(0, 8);
          debugLog(`[session:${short}] stale check: status=running but no live process, correcting to idle`);
          logDiag(id, "idle:stale-check", {
            runtime: session.runtime,
            spawning: session.spawning ?? false,
            hasHarnessProcess: !!session.harnessProcess,
          });
          session.info.status = "idle";
          session.emitter.emit("status", id, "idle");
        }
      }
    }, 15000);
  }

  createSession(
    cwd: string,
    name?: string,
    options?: { bypassPermissions?: boolean; runtime?: SessionRuntime; cockpitAgent?: boolean; runContext?: RunContext },
  ): SessionInfo {
    const id = uuidv4();
    const now = Date.now();
    const defaults = getDefaults();
    const modelSlots: ModelSlots = { main: defaults.modelSlots.main ?? "sonnet" };
    const isCockpitAgent = options?.cockpitAgent === true;
    const rt = options?.runtime ?? this.defaultRuntime;
    const sessionName = isCockpitAgent ? "Cockpit Assistant" : name || path.basename(cwd) || cwd;
    const info: SessionInfo = {
      id,
      name: sessionName,
      cwd,
      createdAt: now,
      lastActiveAt: now,
      status: "idle",
      model: modelSlots.main,
      contextSize: defaults.modelSlots?.mainContext ?? DEFAULT_CONTEXT_SIZE,
      runtime: rt,
      pendingRequestCount: 0,
    };

    this.sessions.set(id, {
      info,
      harnessProcess: null,
      emitter: new EventEmitter(),
      cliSessionId: id,
      previousCliSessionIds: [],
      bypassAllPermissions: isCockpitAgent ? false : (options?.bypassPermissions ?? defaults.bypassAllPermissions),
      planMode: false,
      needsRespawnForPermissions: false,
      compacting: false,
      thinkingLevel: defaults.thinkingLevel,
      streamState: null,
      contextUsage: null,
      contextWindowSize: this.resolveContextWindow(info.model, info.contextSize ?? DEFAULT_CONTEXT_SIZE),
      todoItems: [],
      pendingRequests: new Map(),
      streamingSnapshot: null,
      queuedMessages: [],
      queuePaused: false,
      modelSlots,
      transcriptBuffer: [],
      transcriptByteOffset: 0,
      transcriptTotalSize: 0,
      bufferCliSessionId: id,
      paginationPrevIds: [],
      runtime: rt,
      todoWatcher: null,
      totalTokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
      cockpitAgent: isCockpitAgent,
      cockpitAgentCleanups: [],
      // Present only for a scheduled job that reports to the inbox. It is what
      // mints a run-scoped MCP token, and what confines that token to the job
      // tools. Deliberately not persisted: it belongs to one run.
      runContext: options?.runContext,
    });

    setSessionPrefs(id, { runtime: rt, ...(isCockpitAgent ? { cockpitAgent: true } : {}) });

    if (isCockpitAgent) {
      this.registerCockpitAgentOnInit(id);
    }

    return info;
  }

  private registerCockpitAgentOnInit(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return; // TypeScript narrows to Session below; push is safe
    const cleanup = this.onInit(id, async (data: InitData) => {
      for (const server of data.mcpServers) {
        if (server.name !== "cockpit-config" && server.status !== "disabled") {
          try {
            await this.mcpToggle(id, server.name, false);
          } catch {
            // best effort — server may not be started yet
          }
        }
      }
    });
    if (cleanup) {
      session.cockpitAgentCleanups.push(cleanup); // destroySession iterates this to unsubscribe
    } else {
      console.warn(`[cockpit-agent] onInit returned null for session ${id.slice(0, 8)}`);
    }
  }

  ensureSession(id: string, cwd: string, opts?: { pinCliSessionId?: string }): Session {
    let session = this.sessions.get(id);
    if (!session) {
      const prefs = getSessionPrefs(id);
      // pinCliSessionId forces the session to resume an exact transcript link
      // (history-view continue), with that link's ancestors as the stitch chain,
      // overriding the usual "resolve to the chain head" behaviour.
      const cliId = opts?.pinCliSessionId || prefs?.cliSessionId || id;
      const prevIds = opts?.pinCliSessionId
        ? (findChainForCliSession(opts.pinCliSessionId)?.truncatedPrevIds ?? [])
        : prefs?.previousCliSessionIds || [];
      const short = id.slice(0, 8);
      debugLog(
        `[session:${short}] ensureSession: cliSessionId=${cliId.slice(0, 8)}, prevIds=[${prevIds.map((p) => p.slice(0, 8)).join(",")}], hasPrefs=${!!prefs}`,
      );
      const defaults = getDefaults();
      const now = Date.now();
      const modelSlots: ModelSlots =
        prefs?.modelSlots ?? (prefs?.model ? { main: prefs.model } : { main: defaults.modelSlots.main ?? "sonnet" });
      const restoredRuntime = prefs?.runtime ?? this.defaultRuntime;
      // Falls back to the app default the same way the model above does.
      // Without that step a session whose prefs predate contextSize came back
      // at 200k however the user had configured their default, and the next
      // send then looked like it was about to overflow.
      const restoredContextSize =
        prefs?.contextSize ?? prefs?.modelSlots?.mainContext ?? defaults.modelSlots?.mainContext ?? DEFAULT_CONTEXT_SIZE;
      session = {
        info: {
          id,
          name: prefs?.name || path.basename(cwd) || cwd,
          cwd,
          createdAt: now,
          lastActiveAt: now,
          status: "idle",
          model: modelSlots.main,
          contextSize: restoredContextSize,
          runtime: restoredRuntime,
          pendingRequestCount: 0,
        },
        harnessProcess: null,
        emitter: new EventEmitter(),
        cliSessionId: cliId,
        previousCliSessionIds: prevIds,
        bypassAllPermissions: (prefs?.cockpitAgent ? false : prefs?.bypassAllPermissions) ?? defaults.bypassAllPermissions,
        planMode: prefs?.planMode ?? false,
        pendingPlanReminder: prefs?.planMode ?? false,
        needsRespawnForPermissions: false,
        compacting: false,
        thinkingLevel:
          prefs?.thinkingLevel ??
          recommendedEffort(resolveModel((prefs?.model || defaults.modelSlots.main) ?? "sonnet")) ??
          defaults.thinkingLevel,
        streamState: null,
        contextUsage: null,
        contextWindowSize: this.resolveContextWindow((prefs?.model || defaults.modelSlots.main) ?? undefined, restoredContextSize),
        todoItems: [],
        pendingRequests: new Map(),
        initData: prefs?.initData,
        streamingSnapshot: null,
        queuedMessages: [],
        queuePaused: false,
        modelSlots,
        transcriptBuffer: [],
        transcriptByteOffset: 0,
        transcriptTotalSize: 0,
        bufferCliSessionId: cliId,
        paginationPrevIds: [],
        runtime: restoredRuntime,
        todoWatcher: null,
        totalTokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
        cockpitAgent: prefs?.cockpitAgent ?? false,
        cockpitAgentCleanups: [],
      };
      this.sessions.set(id, session);
      if (prefs?.cockpitAgent) {
        this.registerCockpitAgentOnInit(id);
      }
    }
    return session!;
  }

  async getOrCreateCockpitAgentSession(): Promise<string> {
    // Fast path: the session is already live in memory (the common case once the
    // modal has been opened this server lifetime). Returns synchronously.
    const stored = getAssistantSettings().sessionId;
    if (stored && this.sessions.has(stored)) return stored;

    // Slow path: restore-from-disk or create-new. There is no `await` between the
    // null-check and the assignment below, so the first caller sets the promise
    // before any other caller can run; every concurrent first-open then awaits
    // that same single execution. The finally clears it for the next miss.
    if (!this._cockpitAgentSessionPromise) {
      this._cockpitAgentSessionPromise = this._resolveOrCreateCockpitAgentSession().finally(() => {
        this._cockpitAgentSessionPromise = null;
      });
    }
    return this._cockpitAgentSessionPromise;
  }

  private async _resolveOrCreateCockpitAgentSession(): Promise<string> {
    const settings = getAssistantSettings();
    const stored = settings.sessionId;
    if (stored) {
      if (this.sessions.has(stored)) return stored; // restored by an earlier caller
      const prefs = getSessionPrefs(stored);
      // Only restore a stored id that is genuinely a cockpit agent session. A
      // pointer to a regular session (e.g. a hand-edited assistant.json) must not
      // be rehydrated here — it would lack the MCP-disable/permission restrictions.
      if (prefs?.cockpitAgent) {
        // The assistant's cwd is always getCockpitDir(); fall back to it when no
        // transcript exists yet (the assistant was changed but never messaged) so
        // its model/thinking still restore from session-prefs instead of the
        // session being recreated from the assistant.json fallback (Sonnet/High).
        const cwd = (await findSessionCwd(prefs.cliSessionId || stored)) ?? (await findSessionCwd(stored)) ?? getCockpitDir();
        // ensureSession rebuilds in-memory state and (Step 5) registers the MCP-disable
        // onInit listener. Model/thinking are restored from session-prefs — which the
        // in-modal selector keeps current — so no re-apply is needed here.
        this.ensureSession(stored, cwd);
        return stored;
      }
    }
    // No stored id, or its transcript is gone — create a fresh session seeded from
    // assistant.json. createSession is synchronous (this.sessions.set before return).
    const info = this.createSession(getCockpitDir(), undefined, {
      cockpitAgent: true,
      runtime: settings.runtime,
    });
    if (settings.model) this.setModel(info.id, settings.model, settings.contextSize);
    if (settings.thinkingLevel) this.setThinkingLevel(info.id, settings.thinkingLevel);
    updateAssistantSettings({ sessionId: info.id });
    return info.id;
  }

  async getSession(id: string): Promise<{
    info: SessionInfo;
    messages: ChatMessage[];
    hasMore: boolean;
    lastUsage: { used: number; total: number } | null;
    promptHistory: string[];
  } | null> {
    let session = this.sessions.get(id);
    if (!session) {
      // After server restart, session isn't in memory but transcript exists on disk.
      // Try cliSessionId from prefs first (may differ from Map key after /clear),
      // then fall back to the Map key itself.
      const prefs = getSessionPrefs(id);
      const cwd = (await findSessionCwd(prefs?.cliSessionId || id)) || (await findSessionCwd(id));
      if (!cwd) return null;
      this.ensureSession(id, cwd);
      session = this.sessions.get(id)!;
    }
    const stitching = getDefaults().messageStitching;
    const willStitch = stitching && session.previousCliSessionIds.length > 0;
    // Load full current session when stitching to avoid losing middle messages.
    // Without stitching, tail-read is fine because byteOffset stays pointing at
    // the current session's file for backward pagination.
    const result = await loadTranscript(session.cliSessionId, session.info.cwd, willStitch ? undefined : { tailLines: 150 });
    let { messages, byteOffset, totalSize, lastUsage } = result;

    session.bufferCliSessionId = session.cliSessionId;

    if (willStitch) {
      for (let i = session.previousCliSessionIds.length - 1; i >= 0; i--) {
        const prevId = session.previousCliSessionIds[i];
        const prevResult = await loadTranscript(prevId, session.info.cwd, { tailLines: 150 });
        if (prevResult.messages.length > 0) {
          const marker: ChatMessage = {
            id: `clear-boundary-${i}`,
            role: "system" as const,
            content: "__context_reset__",
            toolUses: [],
            blocks: [],
            timestamp: Date.now(),
          };
          messages = [...prevResult.messages, marker, ...messages];
          byteOffset = prevResult.byteOffset;
          lastUsage = lastUsage || prevResult.lastUsage;
          session.bufferCliSessionId = prevId;
        }
      }
    }

    // Store buffer for backward pagination
    session.transcriptBuffer = messages;
    session.transcriptByteOffset = byteOffset;
    session.transcriptTotalSize = totalSize;
    // Fresh pagination copy so getMoreHistory doesn't consume the canonical list
    session.paginationPrevIds = stitching ? [...session.previousCliSessionIds] : [];

    // Send last 50 to client, keep rest in buffer
    const PAGE = 50;
    const clientMessages = messages.length > PAGE ? messages.slice(-PAGE) : messages;
    const hasMore = messages.length > PAGE || byteOffset > 0 || (stitching && session.previousCliSessionIds.length > 0);

    const defaultName = path.basename(session.info.cwd) || session.info.cwd;
    if (session.info.name === defaultName && messages.length > 0) {
      const firstUser = messages.find((m) => m.role === "user" && m.content && !m.content.startsWith("[") && !m.content.startsWith("<"));
      if (firstUser) {
        session.info.name = firstUser.content.slice(0, 120);
      }
    }
    const allCliIds = [...session.previousCliSessionIds, session.cliSessionId];
    const historyArrays = await Promise.all(allCliIds.map((id) => loadPromptHistory(id, session.info.cwd)));
    const seen = new Set<string>();
    const allPrompts: string[] = [];
    for (const arr of historyArrays) {
      for (const p of arr) {
        if (seen.has(p)) continue;
        seen.add(p);
        allPrompts.push(p);
      }
    }

    const normalized = lastUsage ? { used: lastUsage.used, total: session.contextWindowSize } : null;
    return { info: session.info, messages: clientMessages, hasMore, lastUsage: normalized, promptHistory: allPrompts };
  }

  async getSessionByCwd(
    id: string,
    cwd: string,
  ): Promise<{
    info: SessionInfo;
    messages: ChatMessage[];
    hasMore: boolean;
    lastUsage: { used: number; total: number } | null;
    promptHistory: string[];
  } | null> {
    this.ensureSession(id, cwd);
    const session = this.sessions.get(id)!;
    const stitching = getDefaults().messageStitching;
    const willStitch = stitching && session.previousCliSessionIds.length > 0;
    const result = await loadTranscript(session.cliSessionId, cwd, willStitch ? undefined : { tailLines: 150 });
    let { messages, byteOffset, totalSize, lastUsage } = result;

    session.bufferCliSessionId = session.cliSessionId;

    if (willStitch) {
      for (let i = session.previousCliSessionIds.length - 1; i >= 0; i--) {
        const prevId = session.previousCliSessionIds[i];
        const prevResult = await loadTranscript(prevId, cwd, { tailLines: 150 });
        if (prevResult.messages.length > 0) {
          const marker: ChatMessage = {
            id: `clear-boundary-${i}`,
            role: "system" as const,
            content: "__context_reset__",
            toolUses: [],
            blocks: [],
            timestamp: Date.now(),
          };
          messages = [...prevResult.messages, marker, ...messages];
          byteOffset = prevResult.byteOffset;
          lastUsage = lastUsage || prevResult.lastUsage;
          session.bufferCliSessionId = prevId;
        }
      }
    }

    // Store buffer for backward pagination
    session.transcriptBuffer = messages;
    session.transcriptByteOffset = byteOffset;
    session.transcriptTotalSize = totalSize;
    // Fresh pagination copy so getMoreHistory doesn't consume the canonical list
    session.paginationPrevIds = stitching ? [...session.previousCliSessionIds] : [];

    // Send last 50 to client, keep rest in buffer
    const PAGE = 50;
    const clientMessages = messages.length > PAGE ? messages.slice(-PAGE) : messages;
    const hasMore = messages.length > PAGE || byteOffset > 0 || (stitching && session.previousCliSessionIds.length > 0);

    // Derive title from first user message if name is still the default
    const defaultName = path.basename(cwd) || cwd;
    if (session.info.name === defaultName && messages.length > 0) {
      const firstUser = messages.find((m) => m.role === "user" && m.content && !m.content.startsWith("[") && !m.content.startsWith("<"));
      if (firstUser) {
        session.info.name = firstUser.content.slice(0, 120);
      }
    }
    const allCliIds = [...session.previousCliSessionIds, session.cliSessionId];
    const historyArrays = await Promise.all(allCliIds.map((id) => loadPromptHistory(id, cwd)));
    const seen = new Set<string>();
    const allPrompts: string[] = [];
    for (const arr of historyArrays) {
      for (const p of arr) {
        if (seen.has(p)) continue;
        seen.add(p);
        allPrompts.push(p);
      }
    }

    const normalized = lastUsage ? { used: lastUsage.used, total: session.contextWindowSize } : null;
    return { info: session.info, messages: clientMessages, hasMore, lastUsage: normalized, promptHistory: allPrompts };
  }

  async getCliSessionView(
    cliId: string,
    cwd: string,
  ): Promise<{
    info: SessionInfo;
    messages: ChatMessage[];
    hasMore: boolean;
    lastUsage: { used: number; total: number } | null;
    promptHistory: string[];
  } | null> {
    if (!transcriptExists(cliId, cwd)) return null;

    const chain = findChainForCliSession(cliId);
    const prevIds = chain ? chain.truncatedPrevIds : [];

    const willStitch = getDefaults().messageStitching && prevIds.length > 0;
    const result = await loadTranscript(cliId, cwd, willStitch ? undefined : { tailLines: 150 });
    let { messages, lastUsage } = result;

    if (willStitch) {
      for (let i = prevIds.length - 1; i >= 0; i--) {
        const prevResult = await loadTranscript(prevIds[i], cwd, { tailLines: 150 });
        if (prevResult.messages.length > 0) {
          const marker: ChatMessage = {
            id: `clear-boundary-${i}`,
            role: "system" as const,
            content: "__context_reset__",
            toolUses: [],
            blocks: [],
            timestamp: Date.now(),
          };
          messages = [...prevResult.messages, marker, ...messages];
          lastUsage = lastUsage || prevResult.lastUsage;
        }
      }
    }

    const PAGE = 50;
    const clientMessages = messages.length > PAGE ? messages.slice(-PAGE) : messages;

    let name = path.basename(cwd) || cwd;
    if (messages.length > 0) {
      const firstUser = messages.find((m) => m.role === "user" && m.content && !m.content.startsWith("[") && !m.content.startsWith("<"));
      if (firstUser) {
        name = firstUser.content.slice(0, 120);
      }
    }

    const allCliIds = [...prevIds, cliId];
    const historyArrays = await Promise.all(allCliIds.map((id) => loadPromptHistory(id, cwd)));
    const seen = new Set<string>();
    const allPrompts: string[] = [];
    for (const arr of historyArrays) {
      for (const p of arr) {
        if (seen.has(p)) continue;
        seen.add(p);
        allPrompts.push(p);
      }
    }

    const prefs = getSessionPrefs(cliId);
    const viewSize = prefs?.contextSize ?? prefs?.modelSlots?.mainContext ?? DEFAULT_CONTEXT_SIZE;
    const normalized = lastUsage ? { used: lastUsage.used, total: contextSizeToWindow(viewSize) } : null;
    return {
      info: { id: cliId, name, cwd, createdAt: Date.now(), lastActiveAt: Date.now(), status: "idle" },
      messages: clientMessages,
      hasMore: messages.length > PAGE,
      lastUsage: normalized,
      promptHistory: allPrompts,
    };
  }

  async getMoreHistory(sessionId: string, beforeMessageId: string): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { messages: [], hasMore: false };

    // Use the pagination-only copy so we never consume the canonical
    // previousCliSessionIds needed for stitching on reconnect.
    const prevIds = session.paginationPrevIds;

    const PAGE = 50;
    const buf = session.transcriptBuffer;

    // Find the message in the buffer
    const idx = buf.findIndex((m) => m.id === beforeMessageId);

    if (idx > 0) {
      // Serve from buffer
      const start = Math.max(0, idx - PAGE);
      const chunk = buf.slice(start, idx);
      const hasMore = start > 0 || session.transcriptByteOffset > 0 || prevIds.length > 0;
      return { messages: chunk, hasMore };
    }

    // Buffer exhausted, read more from disk
    if (session.transcriptByteOffset <= 0) {
      // Current transcript fully read. Chain into previous CLI session transcripts.
      // Skip entries matching the buffer's current session (already loaded via fallback).
      while (prevIds.length > 0 && prevIds[prevIds.length - 1] === session.bufferCliSessionId) {
        prevIds.pop();
      }
      if (prevIds.length === 0) {
        return { messages: [], hasMore: false };
      }
      const prevId = prevIds[prevIds.length - 1];
      const prevResult = await loadTranscript(prevId, session.info.cwd, { tailLines: 150 });
      prevIds.pop();
      session.transcriptByteOffset = prevResult.byteOffset;
      session.bufferCliSessionId = prevId;
      session.transcriptBuffer = [...prevResult.messages, ...buf];
      const newBuf = session.transcriptBuffer;
      const newIdx = newBuf.findIndex((m) => m.id === beforeMessageId);
      if (newIdx > 0) {
        const start = Math.max(0, newIdx - PAGE);
        const chunk = newBuf.slice(start, newIdx);
        const hasMore = start > 0 || session.transcriptByteOffset > 0 || prevIds.length > 0;
        return { messages: chunk, hasMore };
      }
      const chunk = prevResult.messages.slice(-PAGE);
      return { messages: chunk, hasMore: prevResult.byteOffset > 0 || prevIds.length > 0 };
    }

    const cwd = session.info.cwd;
    const result = await loadMoreMessages(session.bufferCliSessionId, cwd, session.transcriptByteOffset, 150);
    session.transcriptByteOffset = result.newByteOffset;

    // Prepend to buffer
    session.transcriptBuffer = [...result.messages, ...buf];

    // Serve a page from the newly loaded messages
    const newBuf = session.transcriptBuffer;
    const newIdx = newBuf.findIndex((m) => m.id === beforeMessageId);
    if (newIdx > 0) {
      const start = Math.max(0, newIdx - PAGE);
      const chunk = newBuf.slice(start, newIdx);
      const hasMore = start > 0 || session.transcriptByteOffset > 0 || prevIds.length > 0;
      return { messages: chunk, hasMore };
    }

    // Fallback: return whatever we loaded
    const chunk = result.messages.slice(-PAGE);
    return { messages: chunk, hasMore: result.newByteOffset > 0 || prevIds.length > 0 };
  }

  getTranscriptBuffer(id: string): ChatMessage[] {
    return this.sessions.get(id)?.transcriptBuffer ?? [];
  }

  getStreamingSnapshot(id: string): StreamingSnapshot | null {
    return this.sessions.get(id)?.streamingSnapshot ?? null;
  }

  isCompacting(id: string): boolean {
    return this.sessions.get(id)?.compacting ?? false;
  }

  getRuntime(id: string): "pty" | "stream" {
    return this.sessions.get(id)?.runtime ?? "stream";
  }

  getSessionCwd(id: string): string | null {
    return this.sessions.get(id)?.info.cwd ?? null;
  }

  getCliSessionId(id: string): string | null {
    return this.sessions.get(id)?.cliSessionId ?? null;
  }

  getSessionModel(id: string): string | null {
    return this.sessions.get(id)?.info.model ?? null;
  }

  listActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((s) => !!s.harnessProcess?.isAlive)
      .map((s) => s.info);
  }

  listKnownSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.info);
  }

  getKnownMcpServers(): string[] {
    const names = new Set<string>();
    for (const session of this.sessions.values()) {
      for (const server of session.initData?.mcpServers || []) {
        names.add(server.name);
      }
    }
    if (names.size === 0) {
      for (const name of loadMcpServerCache()) {
        names.add(name);
      }
    }
    return Array.from(names);
  }

  isProcessAlive(id: string): boolean {
    const session = this.sessions.get(id);
    return !!session?.harnessProcess?.isAlive;
  }

  hasRunningProcess(id: string): boolean {
    const session = this.sessions.get(id);
    return !!session?.harnessProcess?.isAlive;
  }

  fixStaleStatus(id: string): void {
    const session = this.sessions.get(id);
    if (session && session.info.status === "running" && !session.harnessProcess?.isAlive) {
      session.info.status = "idle";
      session.pendingRequests.clear();
      this.notifyPendingChanged(session, id);
    }
  }

  restartSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.info.status === "running") {
      this.emitSystem(session, sessionId, "Cannot restart while running. Interrupt first.");
      return false;
    }

    this.killProcess(session);
    session.pendingRequests.clear();
    this.notifyPendingChanged(session, sessionId);
    session.streamingSnapshot = null;
    session.info.status = "idle";
    session.emitter.emit("status", sessionId, "idle");
    this.spawnProcess(session, sessionId);
    this.emitSystem(session, sessionId, "Session restarted — agents and commands reloaded");
    return true;
  }

  destroySession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.harnessProcess) {
      const handle = session.harnessProcess;
      session.harnessProcess = null;
      handle.kill("session_destroyed");
    }
    if (session.todoWatcher) {
      session.todoWatcher.stop();
      session.todoWatcher = null;
    }
    for (const cleanup of session.cockpitAgentCleanups) {
      try {
        cleanup();
      } catch {
        /* best effort */
      }
    }
    if (session.mcpToken) {
      clearToken(session.mcpToken);
      const configPath = path.join(tmpdir(), "cockpit-mcp-config", `${session.mcpToken.slice(0, 16)}.json`);
      try {
        unlinkSync(configPath);
      } catch {
        /* best effort */
      }
    }
    session.emitter.removeAllListeners();
    this.sessions.delete(id);
    return true;
  }

  subscribe(id: string, listener: (event: ParsedEvent) => void): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;

    const handler = (_sessionId: string, event: ParsedEvent) => {
      listener(event);
    };

    session.emitter.on("event", handler);
    return () => session.emitter.off("event", handler);
  }

  onStatus(id: string, listener: (status: "idle" | "running") => void): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) {
      smLog(id, "onStatus: session not in memory, returning null");
      return null;
    }

    const handler = (_sessionId: string, status: "idle" | "running") => {
      listener(status);
    };

    session.emitter.on("status", handler);
    return () => session.emitter.off("status", handler);
  }

  onPending(id: string, listener: (count: number) => void): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;

    const handler = (_sessionId: string, count: number) => {
      listener(count);
    };

    session.emitter.on("pending", handler);
    return () => session.emitter.off("pending", handler);
  }

  onError(id: string, listener: (error: string) => void): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;

    const handler = (_sessionId: string, error: string) => {
      listener(error);
    };

    session.emitter.on("error", handler);
    return () => session.emitter.off("error", handler);
  }

  onTranscript(id: string, listener: (messages: ChatMessage[]) => void): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const handler = (_sessionId: string, messages: ChatMessage[]) => listener(messages);
    session.emitter.on("transcript", handler);
    return () => session.emitter.off("transcript", handler);
  }

  interrupt(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      logDiag(id, "interrupt:no-process", { hasSession: false });
      return false;
    }

    // Pause the queue atomically with the interrupt so
    // flushQueuedMessage (called on message_done) becomes a no-op.
    if (session.queuedMessages.length > 0) {
      session.queuePaused = true;
    }

    if (!session.harnessProcess?.isAlive) {
      logDiag(id, "interrupt:no-process", { hasSession: true });
      return false;
    }

    logDiag(id, "interrupt:send");
    session.harnessProcess.interrupt();

    // PTY's Esc cancels the claude TUI turn but may not produce a Stop hook if
    // it arrived before any response. Force-idle so the UI unsticks; the PTY
    // process stays alive at its REPL prompt and accepts the next message.
    // Stream's control_request interrupt keeps the process alive too, so this
    // early idle-reset is harmless there — its own Stop event still lands.
    if (session.runtime === "pty" && session.info.status === "running") {
      session.info.status = "idle";
      session.streamingSnapshot = null;
      if (session.streamState) {
        session.streamState.pendingBlocks.length = 0;
        session.streamState.pendingToolUses.length = 0;
        session.streamState.agentStack.length = 0;
        session.streamState.currentAssistantMsgId = null;
        session.streamState.flushedOnMessageDone = false;
      }
      session.emitter.emit("status", id, "idle");
    }
    session.pendingRequests.clear();
    this.notifyPendingChanged(session, id);
    return true;
  }

  addPendingRequest(sessionId: string, request: PendingRequest): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pendingRequests.set(request.requestId, request);
      this.notifyPendingChanged(session, sessionId);
    }
  }

  removePendingRequest(sessionId: string, requestId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pendingRequests.delete(requestId);
      this.notifyPendingChanged(session, sessionId);
    }
  }

  getPendingRequests(sessionId: string): PendingRequest[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return Array.from(session.pendingRequests.values());
  }

  getPendingRequest(sessionId: string, requestId: string): PendingRequest | undefined {
    return this.sessions.get(sessionId)?.pendingRequests.get(requestId);
  }

  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    toolInput?: Record<string, unknown>,
    permissionSuggestions?: Record<string, unknown>[],
    denyReason?: string,
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.harnessProcess?.isAlive) return false;

    session.pendingRequests.delete(requestId);
    this.notifyPendingChanged(session, sessionId);
    return session.harnessProcess.respondToPermission(requestId, allowed, toolInput, permissionSuggestions, denyReason);
  }

  private sendPermissionMode(session: Session, sessionId: string, mode: string): void {
    if (!session.harnessProcess?.writeControlRequest) return;
    this.log(sessionId, `sending set_permission_mode: ${mode}`);
    session.harnessProcess.writeControlRequest({
      type: "control_request",
      request_id: `perm-${Date.now()}`,
      request: { subtype: "set_permission_mode", mode },
    });
  }

  setBypassAllPermissions(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.bypassAllPermissions || session.cockpitAgent) return;
    session.bypassAllPermissions = true;
    setSessionPrefs(sessionId, { bypassAllPermissions: true });
    // Don't change CLI mode while in plan mode; bypass will restore on plan exit
    if (!session.planMode) {
      this.sendPermissionMode(session, sessionId, "bypassPermissions");
      this.scheduleRespawnForPermissions(session);
    }
    this.emitSystem(session, sessionId, "__bypass_state::on");
  }

  clearBypassAllPermissions(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.bypassAllPermissions) return;
    session.bypassAllPermissions = false;
    setSessionPrefs(sessionId, { bypassAllPermissions: false });
    if (!session.planMode) {
      this.sendPermissionMode(session, sessionId, "default");
      this.scheduleRespawnForPermissions(session);
    }
    this.emitSystem(session, sessionId, "__bypass_state::off");
  }

  // Runtime set_permission_mode is unreliable when the CLI was spawned without
  // the target mode. Respawning the process picks up --permission-mode from
  // session state, guaranteeing the next message runs in the right mode.
  // If a message is in flight, defer until message_done so we don't orphan it.
  private scheduleRespawnForPermissions(session: Session): void {
    if (!session.harnessProcess?.isAlive) return;
    if (session.info.status === "idle") {
      this.killProcess(session);
    } else {
      session.needsRespawnForPermissions = true;
    }
  }

  setRuntime(sessionId: string, runtime: "pty" | "stream"): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.runtime === runtime) return false;
    session.runtime = runtime;
    session.info.runtime = runtime;
    setSessionPrefs(sessionId, { runtime });
    this.killProcess(session);
    this.emitInfoUpdated(session, sessionId);
    return true;
  }

  isBypassActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.bypassAllPermissions ?? false;
  }

  setPlanMode(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.planMode = true;
    session.pendingPlanReminder = true;
    setSessionPrefs(sessionId, { planMode: true });
    // Kill process so it restarts without --allow-dangerously-skip-permissions,
    // which lets the CLI natively enforce plan mode tool restrictions.
    if (session.harnessProcess?.isAlive) {
      this.killProcess(session);
      session.info.status = "idle";
      session.emitter.emit("status", sessionId, "idle");
    }
    // Clear orphaned pending requests from the killed process
    session.pendingRequests.clear();
    this.notifyPendingChanged(session, sessionId);
    this.emitSystem(session, sessionId, "__plan_state::on");
  }

  clearPlanMode(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.planMode) return;
    session.planMode = false;
    setSessionPrefs(sessionId, { planMode: false });
    // Kill process so it restarts with --allow-dangerously-skip-permissions,
    // restoring bypass capability for build mode.
    if (session.harnessProcess?.isAlive) {
      this.killProcess(session);
      session.info.status = "idle";
      session.emitter.emit("status", sessionId, "idle");
    }
    // Clear orphaned pending requests from the killed process
    session.pendingRequests.clear();
    this.notifyPendingChanged(session, sessionId);
    this.emitSystem(session, sessionId, "__plan_state::off");
    // Re-sync bypass state with the client so the UI reflects it correctly
    // after the plan-mode process is torn down.
    if (session.bypassAllPermissions) {
      this.emitSystem(session, sessionId, "__bypass_state::on");
    }
  }

  isPlanModeActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.planMode ?? false;
  }

  setModel(sessionId: string, model: string, contextSize?: ContextSize): void {
    const session = this.sessions.get(sessionId);
    this.log(
      sessionId,
      `setModel: requested=${model} size=${contextSize ?? "(unspecified)"}, current=${session?.info.model} currentSize=${session?.info.contextSize ?? "(unset)"}, hasHarnessProcess=${!!session?.harnessProcess}`,
    );
    if (!session) return;

    const currentSize = session.info.contextSize ?? DEFAULT_CONTEXT_SIZE;
    const requestedSize = contextSize ?? currentSize;
    const resolvedSize: ContextSize = (() => {
      const sizes = resolveModel(model)?.contextSizes;
      if (!sizes || sizes.length === 0) return requestedSize;
      return sizes.includes(requestedSize) ? requestedSize : sizes[0];
    })();
    // CLAUDE_CODE_DISABLE_1M_CONTEXT is applied at spawn, so a context-size
    // change mid-session requires a CLI restart to take effect.
    const contextChanged = currentSize !== resolvedSize;

    if (session.info.model === model && !contextChanged) {
      this.log(sessionId, `setModel: skipping (already ${model} with size ${resolvedSize})`);
      return;
    }

    session.info.model = model;
    session.info.contextSize = resolvedSize;
    session.modelSlots = { ...session.modelSlots, main: model, mainContext: resolvedSize };
    setSessionPrefs(sessionId, { model, contextSize: resolvedSize, modelSlots: session.modelSlots });

    const nextEntry = resolveModel(model);
    const coerced = nextEntry
      ? coerceEffort(session.thinkingLevel, nextEntry)
      : (() => {
          const levels = this.modelEffortLevels(model);
          if (levels.length === 0) return null;
          if (session.thinkingLevel === "off") return "off";
          if (levels.includes(session.thinkingLevel)) return session.thinkingLevel;
          return levels[levels.length - 1];
        })();
    const levelChanged = coerced !== null && coerced !== session.thinkingLevel;
    if (levelChanged) {
      session.thinkingLevel = coerced;
      setSessionPrefs(sessionId, { thinkingLevel: coerced });
      this.emitSystem(session, sessionId, `__thinking_level::${coerced}`);
    }

    if (session.harnessProcess?.writeControlRequest && !contextChanged) {
      this.log(sessionId, `setModel: sending control_request set_model=${model}`);
      session.harnessProcess.writeControlRequest({
        type: "control_request",
        request_id: `model-${Date.now()}`,
        request: { subtype: "set_model", model },
      });
      if (this.modelEffortLevels(model).length > 0) {
        session.harnessProcess.writeControlRequest({
          type: "control_request",
          request_id: `effort-${Date.now()}`,
          request: { subtype: "apply_flag_settings", settings: this.thinkingFlagSettings(session.thinkingLevel) },
        });
      } else if (isBuiltinCatalogProvider(this.slotProviderId(model))) {
        // A foreign session spawned with CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
        // keeps its last effort setting across a live switch to a
        // non-reasoning model; shut thinking off explicitly.
        session.harnessProcess.writeControlRequest({
          type: "control_request",
          request_id: `effort-${Date.now()}`,
          request: { subtype: "apply_flag_settings", settings: this.thinkingFlagSettings("off") },
        });
      }
    } else {
      this.log(
        sessionId,
        `setModel: killing process (hasLiveControl=${!!session.harnessProcess?.writeControlRequest}, contextChanged=${contextChanged})`,
      );
      this.killProcess(session);
      session.queuedMessages.length = 0;
      session.queuePaused = false;
      session.info.status = "idle";
      session.emitter.emit("status", sessionId, "idle");
    }
    this.emitInfoUpdated(session, sessionId);
    session.contextWindowSize = this.resolveContextWindow(model, resolvedSize);
    const cur = session.contextUsage;
    if (cur) {
      // Assign, not just emit. shouldPreCompact reads contextUsage.total, so
      // telling the client the new window while leaving the server on the old
      // one made the first message after a 200k -> 1m switch trip the 85%
      // check and compact a session with plenty of room left.
      const usage: ContextUsage = { used: cur.used, total: session.contextWindowSize };
      session.contextUsage = usage;
      session.emitter.emit("usage", sessionId, usage);
    }
  }

  /** Context gauge total: foreign catalog models carry a raw contextLength;
   *  Anthropic models use the 200k/1m enum. */
  private resolveContextWindow(model: string | undefined, size: ContextSize): number {
    const resolved = model ? resolveProviderModel(model) : null;
    if (resolved?.model.contextLength && resolved.model.contextLength > 0) return resolved.model.contextLength;
    return contextSizeToWindow(size);
  }

  /** Provider id a slot value belongs to. A qualified prefix wins even when
   *  the model no longer resolves (e.g. delisted from the catalog) so scoping
   *  never silently reclassifies a foreign id as Anthropic. Unqualified ids
   *  and aliases resolve, defaulting to Anthropic. */
  private slotProviderId(modelId: string | undefined): string {
    if (!modelId) return "anthropic";
    const colon = modelId.indexOf(":");
    if (colon > 0 && getProvider(modelId.slice(0, colon))) return modelId.slice(0, colon);
    const resolved = resolveProviderModel(modelId);
    return resolved ? resolved.provider.id : "anthropic";
  }

  setModelSlot(sessionId: string, slot: "main" | "subagent" | "fast", modelId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const slots = { ...session.modelSlots };
    // W4: slots are scoped to one provider per session — a CLI process has one
    // base URL and one auth, and non-main slots are bare model ids sent to the
    // main provider's endpoint. A cross-provider main change clears the other
    // slots instead of carrying ids that would 404; a cross-provider non-main
    // set is refused outright.
    if (slot === "main") {
      if (this.slotProviderId(modelId) !== this.slotProviderId(slots.main)) {
        delete slots.subagent;
        delete slots.fast;
      }
    } else if (this.slotProviderId(modelId) !== this.slotProviderId(slots.main)) {
      smLog(sessionId, `setModelSlot: refused cross-provider ${slot} slot ${modelId} (main is ${slots.main ?? "default"})`);
      return;
    }
    slots[slot] = modelId;
    session.modelSlots = slots;
    setSessionPrefs(sessionId, { modelSlots: slots });

    if (slot === "main") {
      this.setModel(sessionId, modelId);
    } else {
      this.killProcess(session);
      session.queuedMessages.length = 0;
      session.queuePaused = false;
      session.info.status = "idle";
      session.emitter.emit("status", sessionId, "idle");
      this.emitInfoUpdated(session, sessionId);
    }
  }

  getModel(sessionId: string): string {
    return this.sessions.get(sessionId)?.info.model || "sonnet";
  }

  /**
   * Settings patch for the CLI's apply_flag_settings / settings file. "off"
   * disables thinking via alwaysThinkingEnabled (there is no --effort value for
   * it); any other level sets effort and ensures thinking is enabled.
   */
  private thinkingFlagSettings(level: ThinkingLevel): Record<string, unknown> {
    return level === "off" ? { alwaysThinkingEnabled: false } : { effort: level, alwaysThinkingEnabled: true };
  }

  setThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.thinkingLevel === level) return;
    session.thinkingLevel = level;
    setSessionPrefs(sessionId, { thinkingLevel: level });

    const supportsEffort = this.modelEffortLevels(session.info.model).length > 0;
    if (session.harnessProcess?.writeControlRequest && supportsEffort) {
      session.harnessProcess.writeControlRequest({
        type: "control_request",
        request_id: `effort-${Date.now()}`,
        request: { subtype: "apply_flag_settings", settings: this.thinkingFlagSettings(level) },
      });
    } else if (!session.harnessProcess?.writeControlRequest) {
      this.killProcess(session);
      session.queuedMessages.length = 0;
      session.queuePaused = false;
      session.info.status = "idle";
      session.emitter.emit("status", sessionId, "idle");
    }
    this.emitSystem(session, sessionId, `__thinking_level::${level}`);
  }

  getThinkingLevel(sessionId: string): ThinkingLevel {
    return this.sessions.get(sessionId)?.thinkingLevel ?? "high";
  }

  sendControlRequest(sessionId: string, request: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const session = this.sessions.get(sessionId);
    const harnessProcess = session?.harnessProcess;
    if (!harnessProcess?.writeControlRequest) return Promise.reject(new Error("Session not connected"));

    const requestId = `ctrl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const msg = {
      type: "control_request",
      request_id: requestId,
      request,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        harnessProcess.cancelControlRequest?.(requestId);
        reject(new Error("Control request timed out"));
      }, timeoutMs);

      harnessProcess.writeControlRequest!(msg, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  async mcpStatus(sessionId: string): Promise<Record<string, unknown>> {
    return this.sendControlRequest(sessionId, { subtype: "mcp_status" });
  }

  async mcpToggle(sessionId: string, serverName: string, enabled: boolean): Promise<Record<string, unknown>> {
    const result = await this.sendControlRequest(sessionId, { subtype: "mcp_toggle", serverName, enabled });
    this.updateMcpServerStatus(sessionId, serverName, enabled ? "connected" : "disabled");
    return result;
  }

  async mcpReconnect(sessionId: string, serverName: string): Promise<Record<string, unknown>> {
    const result = await this.sendControlRequest(sessionId, { subtype: "mcp_reconnect", serverName });
    this.updateMcpServerStatus(sessionId, serverName, "connected");
    return result;
  }

  private updateMcpServerStatus(sessionId: string, serverName: string, status: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.initData) return;
    const servers = session.initData.mcpServers;
    const server = servers.find((s) => s.name === serverName);
    if (server) {
      server.status = status;
    }
    session.emitter.emit("init", sessionId, session.initData);
    setSessionPrefs(sessionId, { initData: session.initData });
  }

  getContextUsage(sessionId: string): ContextUsage | null {
    return this.sessions.get(sessionId)?.contextUsage ?? null;
  }

  hasQueuedMessage(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session ? session.queuedMessages.length > 0 : false;
  }

  getQueuedCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.queuedMessages.length ?? 0;
  }

  cancelQueuedMessage(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.queuedMessages.length === 0) return null;
    const last = session.queuedMessages.pop()!;
    // Don't emit here — the ws-handler sends the response with cancelledText.
    // Emitting would cause a duplicate session:queued without cancelledText,
    // which can race and prevent the text from being restored to the input.
    return last.text;
  }

  deleteQueuedMessage(sessionId: string, messageId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const idx = session.queuedMessages.findIndex((m) => m.id === messageId);
    if (idx === -1) return false;
    session.queuedMessages.splice(idx, 1);
    return true;
  }

  editQueuedMessage(sessionId: string, messageId: string): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const idx = session.queuedMessages.findIndex((m) => m.id === messageId);
    if (idx === -1) return null;
    const removed = session.queuedMessages.splice(idx, 1)[0];
    return removed.text;
  }

  pauseQueue(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.queuePaused = true;
  }

  resumeQueue(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.queuePaused = false;
    this.flushQueuedMessage(session, sessionId);
  }

  getQueuedMessages(sessionId: string): Array<{ id: string; text: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.queuedMessages.map((m) => ({ id: m.id, text: m.text }));
  }

  isQueuePaused(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.queuePaused ?? false;
  }

  onQueued(id: string, listener: (count: number, sentText?: string) => void): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const handler = (_sessionId: string, count: number, sentText?: string) => listener(count, sentText);
    session.emitter.on("queued", handler);
    return () => session.emitter.off("queued", handler);
  }

  private flushQueuedMessage(session: Session, sessionId: string): void {
    if (session.queuePaused) return;
    if (session.queuedMessages.length === 0) return;
    const next = session.queuedMessages.shift()!;
    session.emitter.emit("queued", sessionId, session.queuedMessages.length, next.text);
    this.sendMessage(sessionId, next.text, next.images, next.documents);
  }

  onUsage(id: string, listener: (usage: ContextUsage) => void): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const handler = (_sessionId: string, usage: ContextUsage) => listener(usage);
    session.emitter.on("usage", handler);
    return () => session.emitter.off("usage", handler);
  }

  getTodos(sessionId: string): TodoItem[] {
    return this.sessions.get(sessionId)?.todoItems ?? [];
  }

  onTodos(id: string, listener: (todos: TodoItem[]) => void): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const handler = (_sessionId: string, todos: TodoItem[]) => listener(todos);
    session.emitter.on("todos", handler);
    return () => session.emitter.off("todos", handler);
  }

  getInitData(sessionId: string): InitData | undefined {
    return this.sessions.get(sessionId)?.initData || getSessionPrefs(sessionId)?.initData;
  }

  setInitData(sessionId: string, data: InitData): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Merge with existing init data so system/init and initialize
    // control_response complement each other.
    // Also fall back to session-prefs so data survives server restarts.
    const prev = session.initData || getSessionPrefs(sessionId)?.initData;
    session.initData = {
      slashCommands: data.slashCommands.length > 0 ? data.slashCommands : prev?.slashCommands || [],
      skills: data.skills.length > 0 ? data.skills : prev?.skills || [],
      agents: data.agents.length > 0 ? data.agents : prev?.agents || [],
      version: data.version || prev?.version || "",
      model: data.model || prev?.model || "",
      mcpServers: data.mcpServers.length > 0 ? data.mcpServers : prev?.mcpServers || [],
      models: data.models || prev?.models,
      account: data.account || prev?.account,
      commands: data.commands || prev?.commands,
    };
    session.emitter.emit("init", sessionId, session.initData);
    setSessionPrefs(sessionId, { initData: session.initData });
    if (session.initData.mcpServers.length > 0) {
      saveMcpServerCache(this.getKnownMcpServers());
    }
  }

  onInit(id: string, listener: (data: InitData) => void): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const handler = (_sessionId: string, data: InitData) => listener(data);
    session.emitter.on("init", handler);
    return () => session.emitter.off("init", handler);
  }

  loadTodosFromFiles(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.todoItems.length > 0) return;
    const watcher = new TodoWatcher(session.cliSessionId, () => {});
    const todos = watcher.readOnce();
    if (todos.length === 0) return;
    session.todoItems = todos;
    session.emitter.emit("todos", sessionId, [...session.todoItems]);
  }

  private startTodoWatcher(session: Session, sessionId: string): void {
    if (session.todoWatcher) {
      session.todoWatcher.stop();
    }
    const watcher = new TodoWatcher(session.cliSessionId, (todos) => {
      session.todoItems = todos;
      session.emitter.emit("todos", sessionId, [...todos]);
    });
    session.todoWatcher = watcher;
    watcher.start();
  }

  private extractUsage(session: Session, sessionId: string, line: string): void {
    try {
      const raw = JSON.parse(line.trim());

      if (raw.type !== "assistant" || !raw.message?.usage) return;
      // Skip synthetic responses (e.g. /context) that have all-zero usage
      if (raw.message.model === "<synthetic>") return;
      const u = raw.message.usage;
      const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      // Only move the gauge on a real reading. An interrupted/cancelled turn
      // emits an all-zero usage block; setting it would wipe the gauge to 0.
      if (used > 0) {
        const usage: ContextUsage = { used, total: session.contextWindowSize };
        session.contextUsage = usage;
        // JOB-DEBUG: context trajectory, to correlate a teardown with the auto-compact threshold.
        logDiag(sessionId, "sm:usage", {
          used,
          total: session.contextWindowSize,
          pct: Math.round((used / session.contextWindowSize) * 100),
          compacting: session.compacting,
        });
        session.emitter.emit("usage", sessionId, usage);
      }
      session.totalTokens.input += u.input_tokens || 0;
      session.totalTokens.output += u.output_tokens || 0;
      session.totalTokens.cacheCreate += u.cache_creation_input_tokens || 0;
      session.totalTokens.cacheRead += u.cache_read_input_tokens || 0;
    } catch {
      // not valid JSON, ignore
    }
  }

  private killProcess(session: Session): void {
    if (session.harnessProcess) {
      const handle = session.harnessProcess;
      session.harnessProcess = null;
      handle.kill("session_reset");
    }
    // A kill ends any in-flight spawn, so clear the ensureProcess guard now. A
    // deliberate kill-then-respawn (settings change, /clear, restart) must not
    // be blocked until the dying runtime's start() promise happens to settle.
    session.spawning = false;
    session.compacting = false;
  }

  private emitSystem(session: Session, sessionId: string, text: string): void {
    session.emitter.emit("system", sessionId, text);
  }

  /**
   * Sonnet 4.6 was asked for 1M but the account has no usage credits. Drop the
   * session to 200K so it stops erroring on every turn, and tell the user why.
   */
  private handle1mCreditsUnavailable(session: Session, sessionId: string): void {
    logDiag(sessionId, "1m:credits-required", { model: session.info.model });
    if (session.info.contextSize !== "200k") {
      session.info.contextSize = "200k";
      session.contextWindowSize = contextSizeToWindow("200k");
      session.modelSlots = { ...session.modelSlots, mainContext: "200k" };
      setSessionPrefs(sessionId, { contextSize: "200k", modelSlots: session.modelSlots });
      this.emitInfoUpdated(session, sessionId);
      const cur = session.contextUsage;
      if (cur) {
        const usage: ContextUsage = { used: cur.used, total: session.contextWindowSize };
        session.contextUsage = usage;
        session.emitter.emit("usage", sessionId, usage);
      }
    }
    this.emitSystem(
      session,
      sessionId,
      "Sonnet 4.6's 1M context needs usage credits (claude.ai/settings/usage), which aren't enabled, so this session dropped to 200K. Enable credits and reselect 1M, or turn off \"1M for Sonnet\" in settings.",
    );
  }

  private notifyPendingChanged(session: Session, sessionId: string): void {
    const count = session.pendingRequests.size;
    if (session.info.pendingRequestCount === count) return;
    session.info.pendingRequestCount = count;
    session.emitter.emit("pending", sessionId, count);
  }

  private applyProcessedResult(session: Session, sessionId: string, result: import("./stream-processor").ProcessedResult): void {
    const eventTypes = result.emit.map((e) => e.type).join(", ");
    if (eventTypes) {
      console.log(
        `[sm] applyProcessedResult for ${sessionId.slice(0, 8)}: events=[${eventTypes}], statusChange=${result.statusChange ?? "none"}, currentStatus=${session.info.status}`,
      );
    }
    for (const msg of result.intermediateMessages) {
      session.emitter.emit("event", sessionId, { type: "message_done", message: msg } as ParsedEvent);
      if (msg.toolUses.some((t: ToolUse) => t.name === "Agent")) {
        this.loadAgentChildren(session, sessionId, msg.id, session.info.cwd);
      }
    }

    for (const sysMsg of result.systemMessages) {
      if (sysMsg === "__tool_use_start") {
        session.info.status = "running";
        console.log(`[sm] emit status running (via tool_use_start) for ${sessionId.slice(0, 8)} (runtime=${session.runtime})`);
        session.emitter.emit("status", sessionId, "running");
        continue;
      }
      if (sysMsg === "__compact::hook_start") {
        if (!session.compacting) {
          logDiag(sessionId, "compact:hook-start");
          session.compacting = true;
          this.emitSystem(session, sessionId, "__compact::start");
        }
        continue;
      }
      if (sysMsg.startsWith("__compact::hook_done")) {
        if (session.compacting) {
          // A compaction is not a turn ending. The CLI auto-compacts mid-turn
          // when the context fills (it fires ~40-50ms after a tool_result) and
          // then resumes the same turn on its own roughly 4s after PostCompact.
          // Reporting idle for that made the job scheduler mark the run a
          // success and destroySession the PTY 1ms after PostCompact — 9ms
          // before the CLI had even flushed the compacted transcript — so both
          // the compaction and the rest of the turn were lost. Only a manual
          // /compact has no turn to resume; the real end of an auto-compacted
          // turn still arrives later as a Stop hook, i.e. message_done.
          const auto = sysMsg === "__compact::hook_done::auto";
          logDiag(sessionId, "compact:hook-done", { auto });
          session.compacting = false;
          this.emitSystem(session, sessionId, "__compact::done");
          const postCompactEstimate: ContextUsage = {
            used: Math.round(session.contextWindowSize * 0.1),
            total: session.contextWindowSize,
          };
          session.contextUsage = postCompactEstimate;
          session.emitter.emit("usage", sessionId, postCompactEstimate);
          if (!auto) {
            session.info.status = "idle";
            session.emitter.emit("status", sessionId, "idle");
            // Flushing after an auto-compact would inject the queued message
            // into the turn the CLI is about to resume. message_done flushes it
            // at the real end of the turn instead.
            this.flushQueuedMessage(session, sessionId);
          }
        }
        continue;
      }
      const permModePrefix = "__permission_mode::";
      if (sysMsg.startsWith(permModePrefix)) {
        const mode = sysMsg.slice(permModePrefix.length);
        if (mode === "plan" && !session.planMode) {
          session.planMode = true;
          setSessionPrefs(sessionId, { planMode: true });
          this.emitSystem(session, sessionId, "__plan_state::on");
        } else if (mode !== "plan" && session.planMode) {
          session.planMode = false;
          setSessionPrefs(sessionId, { planMode: false });
          session.needsRespawnForPermissions = true;
          this.emitSystem(session, sessionId, "__plan_state::off");
        }
      } else {
        this.emitSystem(session, sessionId, sysMsg);
      }
    }

    for (const errMsg of result.errors) {
      session.emitter.emit("error", sessionId, errMsg);
    }

    // After exiting plan mode the CLI process is killed and respawned with the
    // correct --permission-mode flag (see needsRespawnForPermissions). Between
    // the plan exit and the message_done that triggers the respawn, the old
    // process may still send permission_request events. The server auto-approves
    // these so the CLI isn't blocked, but we must also suppress the events from
    // reaching the UI -- otherwise the user sees phantom permission prompts that
    // don't actually gate anything.
    const bypassedRequestIds = new Set<string>();
    for (const pa of result.permissionActions) {
      if (pa.type === "auto_approve") {
        this.respondToPermission(sessionId, pa.requestId, true, pa.rawToolInput);
      } else if (pa.type === "auto_deny") {
        this.respondToPermission(sessionId, pa.requestId, false, undefined, undefined, pa.denyReason);
      } else if (session.cockpitAgent && pa.toolName !== "AskUserQuestion" && !AGENT_PROMPTED_TOOLS.has(pa.toolName)) {
        const tool = pa.toolName;
        const isReadOnlyBuiltin = ["Read", "Grep", "Glob"].includes(tool);
        const cockpitPrefix = "mcp__cockpit-config__";
        const isCockpitTool = tool.startsWith(cockpitPrefix);
        const cockpitAction = isCockpitTool ? tool.slice(cockpitPrefix.length).split("_")[0] : "";
        const isCockpitRead = isCockpitTool && (cockpitAction === "list" || cockpitAction === "get");
        const isCockpitWrite = isCockpitTool && !isCockpitRead;
        logDiag(sessionId, "cockpit-agent:permission", {
          toolName: tool,
          decision: isReadOnlyBuiltin || isCockpitRead ? "auto_approve" : isCockpitWrite ? "proposal" : "auto_deny",
        });

        if (isReadOnlyBuiltin || isCockpitRead) {
          this.respondToPermission(sessionId, pa.requestId, true, pa.rawToolInput);
        } else if (isCockpitWrite) {
          const suffix = tool.replace("mcp__cockpit-config__", "");
          const parts = suffix.split("_");
          const action = parts[0];
          const domain = parts.slice(1).join("_");
          // Every job tool, not just update/delete: run_job and stop_job used to
          // render as a bare uuid on the approval card.
          const displayName = domain === "job" ? describeJobTargets(pa.rawToolInput, (id) => getJob(id)?.name) : undefined;
          session.pendingRequests.set(pa.requestId, {
            type: "permission",
            requestId: pa.requestId,
            toolName: pa.toolName,
            toolInput: pa.toolInput || "",
            rawToolInput: pa.rawToolInput,
            configProposal: { toolName: tool, domain, action, ...(displayName ? { displayName } : {}) },
          });
          this.notifyPendingChanged(session, sessionId);
        } else {
          this.respondToPermission(
            sessionId,
            pa.requestId,
            false,
            undefined,
            undefined,
            "This tool is not available in the cockpit assistant",
          );
        }
        // Reached by the assistant only for AGENT_PROMPTED_TOOLS, so bypass
        // covers its tool calls without touching the config-write proposal
        // cards, which the branch above still handles.
      } else if (session.bypassAllPermissions && !session.planMode && pa.toolName !== "AskUserQuestion") {
        this.respondToPermission(sessionId, pa.requestId, true, pa.rawToolInput);
        bypassedRequestIds.add(pa.requestId);
      } else {
        const planPath = pa.toolName === "ExitPlanMode" ? findLatestPlanFile() : undefined;
        const reqType = pa.toolName === "AskUserQuestion" ? "question" : "permission";
        session.pendingRequests.set(pa.requestId, {
          type: reqType,
          requestId: pa.requestId,
          toolName: pa.toolName,
          toolInput: pa.toolInput || "",
          rawToolInput: pa.rawToolInput,
          permissionSuggestions: pa.permissionSuggestions,
          planFilePath: planPath,
          planContent: planPath ? readPlanFile(planPath) : undefined,
        });
        this.notifyPendingChanged(session, sessionId);
      }
    }

    if (result.compactDone) {
      session.compacting = false;
      this.emitSystem(session, sessionId, "__compact::done");
      const postCompactEstimate: ContextUsage = {
        used: Math.round(session.contextWindowSize * 0.1),
        total: session.contextWindowSize,
      };
      session.contextUsage = postCompactEstimate;
      session.emitter.emit("usage", sessionId, postCompactEstimate);
    }

    if (result.emit.length > 0) {
      const listeners = session.emitter.listenerCount("event");
      if (listeners === 0) {
        smLog(sessionId, `applyProcessedResult: ${result.emit.length} events but 0 event listeners`);
      }
    }
    for (const event of result.emit) {
      // Skip phantom permission events that were already bypass-approved above
      if (event.type === "permission_request" && event.requestId && bypassedRequestIds.has(event.requestId)) continue;
      session.emitter.emit("event", sessionId, event);
    }

    session.streamingSnapshot = result.snapshot;

    const lastEmit = result.emit[result.emit.length - 1];
    if (lastEmit?.type === "message_done" && lastEmit.message) {
      if (lastEmit.message.toolUses.some((t: ToolUse) => t.name === "Agent")) {
        this.loadAgentChildren(session, sessionId, lastEmit.message.id, session.info.cwd);
      }
      if (session.needsRespawnForPermissions) {
        session.needsRespawnForPermissions = false;
        this.killProcess(session);
        session.info.status = "idle";
        session.emitter.emit("status", sessionId, "idle");
      }
      // A permission or AskUserQuestion ask blocks the turn from completing
      // until it's resolved one way or another, so any pendingRequests entry
      // still here once the turn produces a message_done is provably stale:
      // either the user answered (which already clears it via
      // respondToPermission) or the CLI's own internal fallback resolved it
      // without ever telling cockpit. This is the only place that catches
      // the second case, otherwise it orphans the sidebar's pending indicator.
      if (session.pendingRequests.size > 0) {
        session.pendingRequests.clear();
        this.notifyPendingChanged(session, sessionId);
      }
    }

    if (result.statusChange === "idle") {
      session.info.status = "idle";
      // JOB-DEBUG: every idle emission with why + state, to catch a spurious idle
      // tearing down a job run mid-turn (this is what the scheduler ends a run on).
      const lastEmitEv = result.emit[result.emit.length - 1];
      logDiag(sessionId, "sm:emit-idle", {
        compacting: session.compacting,
        compactDone: !!result.compactDone,
        emitTypes: result.emit.map((e) => e.type),
        errors: result.errors,
        lastMsgLen: lastEmitEv?.type === "message_done" && lastEmitEv.message ? (lastEmitEv.message.content || "").length : undefined,
      });
      console.log(`[sm] emit status idle for ${sessionId.slice(0, 8)} (runtime=${session.runtime})`);
      session.emitter.emit("status", sessionId, "idle");
      this.flushQueuedMessage(session, sessionId);
    }
  }

  private emitInfoUpdated(session: Session, sessionId: string): void {
    session.emitter.emit("info_updated", sessionId, { ...session.info });
  }

  onSystem(id: string, listener: (text: string) => void): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const handler = (_sessionId: string, text: string) => listener(text);
    session.emitter.on("system", handler);
    return () => session.emitter.off("system", handler);
  }

  onClear(id: string, listener: () => void): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const handler = () => listener();
    session.emitter.on("clear", handler);
    return () => session.emitter.off("clear", handler);
  }

  onInfoUpdated(id: string, listener: (info: SessionInfo) => void): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const handler = (_sessionId: string, info: SessionInfo) => listener(info);
    session.emitter.on("info_updated", handler);
    return () => session.emitter.off("info_updated", handler);
  }

  private handleCommand(sessionId: string, text: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(" ");

    switch (cmd) {
      case "/clear":
      case "/reset":
      case "/new": {
        this.killProcess(session);
        // The CLI doesn't support /clear in stream-json mode, so we
        // generate a new CLI session ID to get a fresh context.
        session.previousCliSessionIds.push(session.cliSessionId);
        session.cliSessionId = uuidv4();
        session.queuedMessages.length = 0;
        session.queuePaused = false;
        session.todoItems = [];
        session.info.status = "idle";
        session.emitter.emit("clear", sessionId);
        session.emitter.emit("status", sessionId, "idle");
        setSessionPrefs(sessionId, {
          cliSessionId: session.cliSessionId,
          previousCliSessionIds: session.previousCliSessionIds,
        });
        return true;
      }

      case "/model": {
        if (!args) {
          const current = session.info.model || "sonnet";
          this.emitSystem(session, sessionId, `__model_picker::${current}`);
          return true;
        }
        this.log(sessionId, `/model command: args="${args}", was=${session.info.model}`);
        // Route through setModel so model + modelSlots.main + contextSize persist
        // together (and the process restarts correctly per runtime). Writing only
        // prefs.model left modelSlots.main stale, and rehydrate prefers modelSlots,
        // so the switch reverted on restart.
        this.setModel(sessionId, args);
        this.emitSystem(session, sessionId, `Model switched to ${args}`);
        return true;
      }

      case "/rename": {
        if (!args) {
          this.emitSystem(session, sessionId, "Usage: /rename <name>");
          return true;
        }
        session.info.name = args;
        setSessionPrefs(sessionId, { name: args });
        this.emitSystem(session, sessionId, `Session renamed to "${args}"`);
        this.emitInfoUpdated(session, sessionId);
        return true;
      }

      case "/help": {
        const helpText = [
          "Cockpit commands:",
          "  /clear, /reset, /new  - Clear conversation and start fresh",
          "  /model [name]         - Show or switch model",
          "  /rename <name>        - Rename this session",
          "  /cost                 - Show session token usage",
          "  /context              - Show context window usage",
          "  /status               - Show session status",
          "  /help                 - Show this help message",
          "",
          "Other commands (/compact, /commit, /review, etc.) are passed to Claude when possible.",
        ].join("\n");
        this.emitSystem(session, sessionId, helpText);
        return true;
      }

      case "/cost": {
        const t = session.totalTokens;
        const lines = [
          `Input tokens:       ${t.input.toLocaleString()}`,
          `Output tokens:      ${t.output.toLocaleString()}`,
          `Cache write tokens: ${t.cacheCreate.toLocaleString()}`,
          `Cache read tokens:  ${t.cacheRead.toLocaleString()}`,
        ];
        this.emitSystem(session, sessionId, lines.join("\n"));
        return true;
      }

      case "/context": {
        // Forward to the CLI's own /context: it shows the live per-category
        // breakdown and the ACTUAL window, which cockpit's readout (picked size
        // only) can't. /context is a local command (no model turn → no Stop hook),
        // so never enter the running state — that would hang the session on
        // "processing". If no CLI is live (e.g. a context-size switch just killed
        // it), spawn one rather than showing cockpit's one-liner; the spawn applies
        // the freshly-picked window so /context reflects the switch immediately.
        // Output arrives as a local_command transcript entry (ANSI-stripped). When a
        // turn is already running we don't interfere — fall back to the local readout.
        if (session.runtime === "pty" && session.info.status !== "running") {
          if (session.harnessProcess?.isAlive) {
            session.harnessProcess.sendRawCommand?.("/context");
          } else {
            this.spawnProcess(session, sessionId, "/context");
          }
          return true;
        }
        if (!session.contextUsage) {
          this.emitSystem(session, sessionId, "Context usage data not available yet.");
          return true;
        }
        const pct = session.contextWindowSize > 0 ? Math.round((session.contextUsage.used / session.contextWindowSize) * 100) : 0;
        this.emitSystem(
          session,
          sessionId,
          `Context window: ${session.contextUsage.used.toLocaleString()} / ${session.contextWindowSize.toLocaleString()} (${pct}%)`,
        );
        return true;
      }

      case "/status": {
        const model = session.info.model || "sonnet";
        const runtime = session.runtime;
        const plan = session.planMode ? " [plan]" : "";
        this.emitSystem(session, sessionId, `Model: ${model}  Runtime: ${runtime}${plan}`);
        return true;
      }
    }

    // In PTY mode, only model-invoking commands are safe to forward to the REPL:
    // they run a turn that fires a Stop hook, which clears the running state.
    // CLI-local commands don't: "local-jsx" opens an interactive panel cockpit
    // renders from the transcript, not the raw PTY, so it can't show or drive; and
    // "local" acts with no Stop hook, hanging the session on "processing". Block
    // both. Classification (incl. aliases) is generated from the CLI binary; see
    // src/lib/cli-commands.ts. Unknown commands (custom/project/plugin) are
    // prompt-style and pass through.
    if (session.runtime === "pty" && session.harnessProcess?.isAlive) {
      const kind = classifyCliCommand(cmd);
      // /compact is CLI-local but cockpit drives compaction through it (PostCompact
      // clears the running state), so it must reach the CLI -- let it pass through.
      const passThrough = SessionManager.PTY_FORWARD_LOCAL.has(cmd.replace(/^\//, ""));
      if (!passThrough && (kind === "local" || kind === "local-jsx")) {
        const detail = kind === "local-jsx" ? "opens an interactive CLI dialog" : "runs in the CLI only";
        this.emitSystem(session, sessionId, `"${cmd}" ${detail} and isn't available in remote mode.`);
        return true;
      }
    }

    // All other slash commands pass through to Claude
    return false;
  }

  // CLI-local commands cockpit intentionally forwards in PTY despite their type,
  // because their lifecycle is handled (e.g. /compact fires PostCompact, which
  // clears the running state the same way a Stop hook would).
  private static readonly PTY_FORWARD_LOCAL = new Set(["compact"]);

  private planModeReminderText(): string {
    return `<system-reminder>
Cockpit plan mode is now active, layered on top of Claude Code's native plan mode.

Additional Cockpit rules beyond the CLI's defaults:
- Bash: only read-only commands are permitted (ls, cat, head, tail, wc, grep, rg, find, stat, file, du, df, tree, pwd, which, type, echo, env, date, basename, dirname, realpath, readlink, uname, whoami, hostname, id). Pipes are allowed; ';', '&&', '||', '>', '<', '$(...)', '\`...\`', '<(...)' are not.
- git: only read-only subcommands (status, log, diff, show, blame, branch, remote, ls-files, ls-tree, rev-parse, describe, tag, reflog).
- Edit, Write, NotebookEdit: blocked. Use ExitPlanMode to submit the plan before making changes.
- Read, Grep, Glob, and all other read-only tools: unrestricted.
</system-reminder>`;
  }

  async recoverSession(id: string, opts?: { cwd?: string; pinExact?: boolean }): Promise<boolean> {
    if (this.sessions.has(id)) return true;
    smLog(id, "recovering session: not in memory, searching disk");
    const prefs = getSessionPrefs(id);
    const cwd = (await findSessionCwd(prefs?.cliSessionId || id)) || (await findSessionCwd(id)) || opts?.cwd;
    if (!cwd) {
      smLog(id, "recovery failed: no transcript found on disk");
      return false;
    }
    // When recovered from a history-view deep link, `id` is the exact transcript
    // link being viewed, which may be an older link of a compacted/cleared chain.
    // Pin it as the cliSessionId so the resume continues that link (--resume
    // appends to the same file) instead of jumping to the chain head — otherwise
    // the view and the agent diverge.
    if (opts?.pinExact && transcriptExists(id, cwd)) {
      this.ensureSession(id, cwd, { pinCliSessionId: id });
    } else {
      this.ensureSession(id, cwd);
    }
    smLog(id, `recovery succeeded: restored from ${cwd}`);
    return true;
  }

  private estimateMessageTokens(text: string, images?: ImageAttachment[], documents?: DocumentAttachment[]): number {
    let tokens = Math.ceil(text.length / 4);
    if (images) tokens += images.length * 2000;
    if (documents) tokens += documents.reduce((sum, d) => sum + Math.ceil(d.data.length / 5), 0);
    return tokens;
  }

  private shouldPreCompact(session: Session, text: string, images?: ImageAttachment[], documents?: DocumentAttachment[]): boolean {
    if (!session.contextUsage) return false;
    if (session.compacting) return false;
    if (text.trim().toLowerCase().startsWith("/compact")) return false;
    if (text.trim().startsWith("/")) return false;
    const estimate = this.estimateMessageTokens(text, images, documents);
    const { used, total } = session.contextUsage;
    return used + estimate > total * 0.85;
  }

  sendMessage(sessionId: string, text: string, images?: ImageAttachment[], documents?: DocumentAttachment[]): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      smLog(sessionId, "sendMessage: session not in memory, returning false");
      logDiag(sessionId, "send:no-session");
      return false;
    }

    if (text.startsWith("/")) {
      const handled = this.handleCommand(sessionId, text);
      if (handled) return true;

      if (text.trim().toLowerCase().startsWith("/compact")) {
        logDiag(sessionId, "compact:start");
        session.compacting = true;
        this.emitSystem(session, sessionId, "__compact::start");
      }
    }

    // If the message would likely overflow the context window, compact first
    // and queue the message for delivery after compaction finishes.
    if (session.info.status !== "running" && this.shouldPreCompact(session, text, images, documents)) {
      this.log(sessionId, "pre-send compact: message would exceed 85% of context window");
      logDiag(sessionId, "compact:pre-send");
      session.queuedMessages.push({ id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, images, documents });
      session.emitter.emit("queued", sessionId, session.queuedMessages.length);
      session.compacting = true;
      this.emitSystem(session, sessionId, "__compact::start");
      session.info.status = "running";
      session.emitter.emit("status", sessionId, "running");
      if (session.harnessProcess?.isAlive) {
        if (!session.harnessProcess.sendRawCommand?.("/compact")) {
          session.harnessProcess.sendUserMessage("/compact");
        }
      } else {
        this.spawnProcess(session, sessionId, "/compact");
      }
      return true;
    }

    // Matches the original buildContent call's unconditional side effect: the
    // plan-mode reminder is consumed here regardless of whether this message
    // ends up queued, sent live, or triggering a fresh spawn.
    const reminder = session.pendingPlanReminder ? this.planModeReminderText() : undefined;
    if (session.pendingPlanReminder) session.pendingPlanReminder = false;

    // If queue was paused (user interrupted then sent a new message),
    // discard the paused messages and reset the flag.
    if (session.queuePaused) {
      session.queuedMessages.length = 0;
      session.queuePaused = false;
      session.emitter.emit("queued", sessionId, 0);
    }

    // If already running, queue the message to send when the session goes idle
    if (session.info.status === "running") {
      session.queuedMessages.push({ id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, images, documents });
      session.emitter.emit("queued", sessionId, session.queuedMessages.length);
      return true;
    }

    // A /compact already in flight can leave status idle with no alive
    // harness process for a while (queued behind the prior turn, then the
    // process exits before PostCompact's hook_done actually arrives) — the
    // gap above only catches status "running", not this. Respawning here to
    // deliver this message races the fresh process against /compact's own
    // delivery into it. Queue instead; flushQueuedMessage runs from every
    // path that clears session.compacting (hook_done, harness exit while
    // compacting, or the transcript's own "__compacted__" marker).
    if (session.compacting) {
      session.queuedMessages.push({ id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, images, documents });
      session.emitter.emit("queued", sessionId, session.queuedMessages.length);
      return true;
    }

    logDiag(sessionId, "running:send", {
      hasHarnessProcess: !!session.harnessProcess,
      runtime: session.runtime,
      alive: !!session.harnessProcess?.isAlive,
    });
    session.info.status = "running";
    console.log(`[sm] emit status running for ${sessionId.slice(0, 8)} (runtime=${session.runtime})`);
    session.emitter.emit("status", sessionId, "running");

    if (session.harnessProcess?.isAlive) {
      if (session.streamState) session.streamState.thinkingStartedAt = Date.now();
      session.harnessProcess.sendUserMessage(text, images, documents, reminder);
      return true;
    }

    this.spawnProcess(session, sessionId, text, images, documents);
    return true;
  }

  private log(sessionId: string, msg: string): void {
    if (!isDebugEnabled()) return;
    const ts = new Date().toISOString().slice(11, 23);
    const short = sessionId.slice(0, 8);
    console.log(`[session:${short}] ${ts} ${msg}`);
  }

  ensureProcess(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    // `spawning` guards the async-startup window: the handle is assigned
    // before its `ready` promise settles, and during that window isAlive can
    // still be false (always true immediately for stream; only after PTY's
    // async start() resolves for pty), so a second ensureProcess (a WS
    // reconnect, or a startup race) would otherwise spawn a duplicate CLI for
    // the same session — two processes racing on the same --session-id.
    if (!session || session.harnessProcess?.isAlive || session.spawning) return;
    this.spawnProcess(session, sessionId);
  }

  /** Check effort levels for built-in models or custom provider models. */
  private modelEffortLevels(modelId: string | null | undefined): ThinkingLevel[] {
    if (!modelId) return [];
    const builtin = resolveModel(modelId);
    if (builtin) return allowedEffortLevels(builtin);
    const resolved = resolveProviderModel(modelId);
    if (resolved) return resolved.model.effortLevels;
    return [];
  }

  private spawnProcess(
    session: Session,
    sessionId: string,
    text?: string,
    images?: ImageAttachment[],
    documents?: DocumentAttachment[],
  ): void {
    const willResume = transcriptExists(session.cliSessionId, session.info.cwd);
    this.log(sessionId, `spawning CLI process (resume=${willResume}, model=${session.info.model || "sonnet"}, runtime=${session.runtime})`);

    const resolved = resolveProviderModel(session.info.model ?? "sonnet");
    const baseCliModel = resolved ? resolved.model.modelId : session.info.model;
    // A credit-gated model (Sonnet 4.6) at 1M only requests its 1M window when
    // the id carries a [1m] suffix, and only if the user opted in. Everything
    // else stays bare (Opus/Sonnet 5/Fable 5 reach 1M from the bare id).
    const allowSonnet1m = getDefaults().allowSonnet1m;
    const cliModel =
      baseCliModel && session.info.contextSize ? cliModelWithContext(baseCliModel, session.info.contextSize, allowSonnet1m) : baseCliModel;
    // When the credit-gated opt-in is off, force the effective context to 200k
    // so the adapter sets CLAUDE_CODE_DISABLE_1M_CONTEXT=1. Without this, a
    // stored contextSize of "1m" would leave the env var unset and the CLI
    // would still run at 1M even without the [1m] suffix.
    const effectiveContextSize: ContextSize =
      session.info.contextSize === "1m" && !allowSonnet1m && modelOneMRequiresCredits(baseCliModel)
        ? "200k"
        : (session.info.contextSize ?? DEFAULT_CONTEXT_SIZE);
    this.log(
      sessionId,
      `spawn: info.model=${session.info.model}, resolved=${resolved ? `${resolved.provider.id}:${resolved.model.modelId}` : "null"}, cliModel=${cliModel}`,
    );

    let subagentModel: string | undefined;
    if (session.modelSlots.subagent && session.modelSlots.subagent !== session.modelSlots.main) {
      const resolvedSub = resolveProviderModel(session.modelSlots.subagent);
      subagentModel = resolvedSub ? resolvedSub.model.modelId : session.modelSlots.subagent;
    }

    // Catalog-backed builtin sessions (openrouter, zen, deepseek) pin every
    // default-model slot to the session's models — otherwise the CLI's
    // internal opus/sonnet/haiku-class utility calls route to Claude models
    // billed on the provider's credits behind the user's back.
    let providerEnvVars = resolved?.provider.envVars;
    if (resolved && isBuiltinCatalogProvider(resolved.provider.id)) {
      providerEnvVars = { ...providerEnvVars, ...openRouterModelEnv(resolved.model.modelId, subagentModel) };
      // The CLI defaults foreign model ids to a 200k context window; this
      // override (ignored for claude-* ids) aligns its context tracking and
      // auto-compact with the model's real window.
      if (resolved.model.contextLength && resolved.model.contextLength > 0) {
        providerEnvVars.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(resolved.model.contextLength);
      }
      // The CLI's effort gate rejects unknown (non-Anthropic) model ids, so
      // --effort would be dropped for foreign reasoning models without this.
      if (resolved.model.effortLevels.length > 0) {
        providerEnvVars.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = "1";
      }
      // Kick a background catalog resync when the cache is older than a day.
      if (resolved.provider.id === OPENROUTER_PROVIDER_ID) ensureCatalogFresh();
    }

    let appendSystemPrompt: string | undefined;
    let mcpConfigPath: string | undefined;
    // Both the assistant and an inbox-reporting job talk to the cockpit MCP
    // server, but only the assistant gets its system prompt: a job has its own,
    // and the token decides which tools either of them can actually reach.
    if (session.cockpitAgent || session.runContext) {
      if (session.cockpitAgent) appendSystemPrompt = COCKPIT_AGENT_SYSTEM_PROMPT;
      const cockpitMcp = getCockpitMcp();
      if (cockpitMcp) {
        if (session.mcpToken) {
          clearToken(session.mcpToken);
          try {
            unlinkSync(path.join(tmpdir(), "cockpit-mcp-config", `${session.mcpToken.slice(0, 16)}.json`));
          } catch {
            /* best effort */
          }
        }
        const token = randomBytes(24).toString("hex");
        if (session.runContext) {
          registerRunContext(token, session.runContext);
        } else {
          registerAuthToken(token);
        }
        session.mcpToken = token;
        mcpConfigPath = buildMcpConfigArg(cockpitMcp.getUrl(), token).path;
      }
    }

    // Matches the original buildContent/buildPtyText call's unconditional side
    // effect: the plan-mode reminder is consumed on every spawn attempt,
    // regardless of whether this specific spawn ends up carrying initial text.
    const reminder = session.pendingPlanReminder ? this.planModeReminderText() : undefined;
    if (session.pendingPlanReminder) session.pendingPlanReminder = false;

    const streamState = createStreamState();
    session.streamState = streamState;
    streamState.thinkingStartedAt = Date.now();

    const { callbacks, handleRef } = this.buildHarnessCallbacks(session, sessionId, streamState);

    const config: HarnessSpawnConfig = {
      sessionId,
      cwd: session.info.cwd,
      cliSessionId: session.cliSessionId,
      willResume,
      model: cliModel ?? undefined,
      providerEnvVars,
      subagentModel,
      contextSize: effectiveContextSize,
      thinkingLevel: session.thinkingLevel,
      supportsEffort: this.modelEffortLevels(session.info.model).length > 0,
      planMode: session.planMode,
      bypassAllPermissions: session.bypassAllPermissions && !session.cockpitAgent,
      cockpitAgent: session.cockpitAgent,
      modelSlots: session.modelSlots,
      appendSystemPrompt,
      mcpConfigPath,
      text,
      images,
      documents,
      reminderText: reminder,
      callbacks,
    };

    const adapter = getHarnessAdapter("claude", session.runtime);

    let handle: HarnessProcess;
    session.spawning = true;
    try {
      handle = adapter.spawn(config);
    } catch (err) {
      session.spawning = false;
      const msg = err instanceof Error ? err.message : String(err);
      this.log(sessionId, `spawn failed: ${msg}`);
      session.info.status = "idle";
      session.emitter.emit("status", sessionId, "idle");
      session.emitter.emit("error", sessionId, msg);
      return;
    }

    session.harnessProcess = handle;
    handleRef.current = handle;
    this.log(sessionId, `CLI process spawned`);
    this.startTodoWatcher(session, sessionId);

    handle.ready
      .then(() => {
        session.spawning = false;
        this.log(sessionId, "CLI ready");
      })
      .catch((err: unknown) => {
        session.spawning = false;
        const msg = err instanceof Error ? err.message : String(err);
        this.log(sessionId, `runtime start failed: ${msg}`);
        if (session.harnessProcess === handle) session.harnessProcess = null;
        // Emit error BEFORE idle: a job's onStatus("idle") maps to success, so an
        // idle-first order would mark a failed spawn as a successful empty run.
        session.emitter.emit("error", sessionId, msg);
        session.info.status = "idle";
        session.emitter.emit("status", sessionId, "idle");
        // Reap the half-started process so a failed delivery can't leak one.
        handle.kill();
      });
  }

  /** Shared between both Claude transports (and any future harness): builds
   *  the callback set a HarnessAdapter drives. onRawLine only ever fires from
   *  the stream adapter (usage-extraction side channel); onTranscriptUpdate
   *  only ever fires from the PTY adapter (its transcript-tailing side
   *  channel) — each is a no-op for the other transport by construction. */
  private buildHarnessCallbacks(
    session: Session,
    sessionId: string,
    streamState: StreamState,
  ): { callbacks: HarnessProcessCallbacks; handleRef: { current: HarnessProcess | null } } {
    const handleRef: { current: HarnessProcess | null } = { current: null };
    const callbacks: HarnessProcessCallbacks = {
      onRawLine: (line) => {
        logRawLine(sessionId, line);
        if (streamState.agentStack.length === 0) {
          this.extractUsage(session, sessionId, line);
        }
      },
      onParsedEvents: (events) => {
        const result = processEvents(events, streamState, { planMode: session.planMode, compacting: session.compacting });
        this.applyProcessedResult(session, sessionId, result);
      },
      onError: (message) => {
        if (message === ONE_M_CREDITS_REQUIRED) {
          this.handle1mCreditsUnavailable(session, sessionId);
          return;
        }
        this.log(sessionId, `CLI error: ${message}`);
        session.emitter.emit("error", sessionId, message);
      },
      onExit: ({ code, signal }) => {
        this.log(sessionId, `CLI process exited (code=${code}, signal=${signal ?? "none"})`);
        if (session.harnessProcess !== handleRef.current) {
          this.log(sessionId, "skipping exit cleanup: newer process already running");
          return;
        }
        session.harnessProcess = null;
        session.spawning = false;
        session.streamingSnapshot = null;
        logDiag(sessionId, "idle:harness-exit", { code, signal: signal ?? null, flushedOnMessageDone: streamState.flushedOnMessageDone });
        session.info.status = "idle";
        session.emitter.emit("status", sessionId, "idle");

        if (session.compacting) {
          logDiag(sessionId, "compact:done-on-exit");
          session.compacting = false;
          this.emitSystem(session, sessionId, "__compact::done");
          const postCompactEstimate: ContextUsage = {
            used: Math.round(session.contextWindowSize * 0.1),
            total: session.contextWindowSize,
          };
          session.contextUsage = postCompactEstimate;
          session.emitter.emit("usage", sessionId, postCompactEstimate);
        }

        if (session.todoItems.length > 0 && session.todoItems.every((t) => t.status === "completed")) {
          session.todoItems = [];
          session.emitter.emit("todos", sessionId, []);
        }

        if (!streamState.flushedOnMessageDone) {
          this.flushQueuedMessage(session, sessionId);
        }
      },
      onTranscriptUpdate: (messages, lastUsage) => {
        session.emitter.emit("transcript", sessionId, messages);
        if (lastUsage) {
          const usage: ContextUsage = { used: lastUsage.used, total: session.contextWindowSize };
          session.contextUsage = usage;
          session.emitter.emit("usage", sessionId, usage);
        }
        if (session.compacting && messages.some((m) => m.content === "__compacted__")) {
          logDiag(sessionId, "compact:done-on-transcript");
          session.compacting = false;
          this.emitSystem(session, sessionId, "__compact::done");
          const postCompactEstimate: ContextUsage = {
            used: Math.round(session.contextWindowSize * 0.1),
            total: session.contextWindowSize,
          };
          session.contextUsage = postCompactEstimate;
          session.emitter.emit("usage", sessionId, postCompactEstimate);
          session.info.status = "idle";
          session.emitter.emit("status", sessionId, "idle");
          this.flushQueuedMessage(session, sessionId);
        }
      },
    };
    // handleRef.current is set by the caller once adapter.spawn() returns —
    // callback invocations only ever happen asynchronously afterward, never
    // during adapter.spawn() itself, so it's populated before it's ever read.
    return { callbacks, handleRef };
  }

  private async loadAgentChildren(session: Session, sessionId: string, messageId: string, cwd: string): Promise<void> {
    try {
      const result = await loadTranscript(session.cliSessionId, cwd);
      const msg = result.messages.find((m) => m.id === messageId);
      if (!msg) return;
      for (const tool of msg.toolUses) {
        if (tool.name !== "Agent" || !tool.children || tool.children.length === 0) continue;
        session.emitter.emit("event", sessionId, {
          type: "tool_children",
          messageId,
          toolId: tool.id,
          children: tool.children,
        } as ParsedEvent);
      }
    } catch {
      // Children will show on next session load
    }
  }
}

function mcpCachePath(): string {
  return path.join(getCockpitDir(), "mcp-servers.json");
}

function loadMcpServerCache(): string[] {
  try {
    const fp = mcpCachePath();
    if (!existsSync(fp)) return [];
    return JSON.parse(readFileSync(fp, "utf-8")) as string[];
  } catch {
    return [];
  }
}

function saveMcpServerCache(servers: string[]): void {
  try {
    const fp = mcpCachePath();
    const dir = path.dirname(fp);
    mkdirSync(dir, { recursive: true });
    writeFileSync(fp, JSON.stringify(servers));
  } catch {
    // best-effort
  }
}
