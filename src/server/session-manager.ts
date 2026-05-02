import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type Writable } from "node:stream";
import { v4 as uuidv4 } from "uuid";
import { allowedEffortLevels, coerceEffort, recommendedEffort, resolveModel } from "@/lib/models";
import type {
  ChatMessage,
  ContentBlock,
  ContextUsage,
  DocumentAttachment,
  ImageAttachment,
  InitData,
  SessionInfo,
  ThinkingLevel,
  TodoItem,
  ToolUse,
} from "@/types";
import { debugLog, isDebugEnabled, logDiag, logRawLine } from "./debug-logger";
import { getDefaults } from "./defaults";
import { EventParser, type ParsedEvent } from "./event-parser";
import { findLatestPlanFile, readPlanFile } from "./plans";
import { findChainForCliSession, getSessionPrefs, setSessionPrefs } from "./session-prefs";
import { createStreamState, processEvents, type StreamState } from "./stream-processor";
import { findSessionCwd, loadMoreMessages, loadTranscript, transcriptExists } from "./transcript";

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
  process: ChildProcess | null;
  stdin: Writable | null;
  emitter: EventEmitter;
  hasSpawnedBefore: boolean;
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
  controlCallbacks: Map<string, (response: Record<string, unknown>) => void>;
  streamingSnapshot: StreamingSnapshot | null;
  queuedMessages: QueuedMessage[];
  queuePaused: boolean;
  transcriptBuffer: ChatMessage[];
  transcriptByteOffset: number;
  transcriptTotalSize: number;
  bufferCliSessionId: string;
  /** Pagination-only copy of previousCliSessionIds, consumed by getMoreHistory
   *  without affecting the canonical list used for stitching on reconnect. */
  paginationPrevIds: string[];
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  constructor() {
    // Periodically check for sessions stuck in "running" with a dead process
    setInterval(() => {
      for (const [id, session] of this.sessions) {
        if (session.info.status === "running" && !session.process) {
          const short = id.slice(0, 8);
          debugLog(`[session:${short}] stale check: status=running but process=null, correcting to idle`);
          logDiag(id, "idle:stale-check");
          session.info.status = "idle";
          session.emitter.emit("status", id, "idle");
        }
      }
    }, 15000);
  }

  createSession(cwd: string, name?: string, options?: { bypassPermissions?: boolean }): SessionInfo {
    const id = uuidv4();
    const now = Date.now();
    const defaults = getDefaults();
    const info: SessionInfo = {
      id,
      name: name || path.basename(cwd) || cwd,
      cwd,
      createdAt: now,
      lastActiveAt: now,
      status: "idle",
      model: defaults.model || undefined,
      pendingRequestCount: 0,
    };

    this.sessions.set(id, {
      info,
      process: null,
      stdin: null,
      emitter: new EventEmitter(),
      hasSpawnedBefore: false,
      cliSessionId: id,
      previousCliSessionIds: [],
      bypassAllPermissions: options?.bypassPermissions ?? defaults.bypassAllPermissions,
      planMode: false,
      needsRespawnForPermissions: false,
      compacting: false,
      thinkingLevel: defaults.thinkingLevel,
      streamState: null,
      contextUsage: null,
      contextWindowSize: 200_000,
      todoItems: [],
      pendingRequests: new Map(),
      controlCallbacks: new Map(),
      streamingSnapshot: null,
      queuedMessages: [],
      queuePaused: false,
      transcriptBuffer: [],
      transcriptByteOffset: 0,
      transcriptTotalSize: 0,
      bufferCliSessionId: id,
      paginationPrevIds: [],
    });

    return info;
  }

  ensureSession(id: string, cwd: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      const prefs = getSessionPrefs(id);
      const defaults = getDefaults();
      const now = Date.now();
      session = {
        info: {
          id,
          name: prefs?.name || path.basename(cwd) || cwd,
          cwd,
          createdAt: now,
          lastActiveAt: now,
          status: "idle",
          model: prefs?.model || defaults.model || undefined,
          pendingRequestCount: 0,
        },
        process: null,
        stdin: null,
        emitter: new EventEmitter(),
        hasSpawnedBefore: true,
        cliSessionId: prefs?.cliSessionId || id,
        previousCliSessionIds: prefs?.previousCliSessionIds || [],
        bypassAllPermissions: prefs?.bypassAllPermissions ?? defaults.bypassAllPermissions,
        planMode: prefs?.planMode ?? false,
        pendingPlanReminder: prefs?.planMode ?? false,
        needsRespawnForPermissions: false,
        compacting: false,
        thinkingLevel: prefs?.thinkingLevel ?? recommendedEffort(resolveModel(prefs?.model || defaults.model)) ?? defaults.thinkingLevel,
        streamState: null,
        contextUsage: null,
        contextWindowSize: 200_000,
        todoItems: [],
        pendingRequests: new Map(),
        controlCallbacks: new Map(),
        initData: prefs?.initData,
        streamingSnapshot: null,
        queuedMessages: [],
        queuePaused: false,
        transcriptBuffer: [],
        transcriptByteOffset: 0,
        transcriptTotalSize: 0,
        bufferCliSessionId: prefs?.cliSessionId || id,
        paginationPrevIds: [],
      };
      this.sessions.set(id, session);
    }
    return session;
  }

  async getSession(
    id: string,
  ): Promise<{ info: SessionInfo; messages: ChatMessage[]; hasMore: boolean; lastUsage: { used: number; total: number } | null } | null> {
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
    const result = await loadTranscript(session.cliSessionId, session.info.cwd, { tailLines: 150 });
    let { messages, byteOffset, totalSize, lastUsage } = result;

    session.bufferCliSessionId = session.cliSessionId;

    // Stitch previous session messages across /clear boundaries so the full
    // conversation is visible on refresh instead of only post-clear messages.
    const stitching = getDefaults().messageStitching;
    if (stitching && session.previousCliSessionIds.length > 0) {
      const currentMessages = messages;
      for (let i = session.previousCliSessionIds.length - 1; i >= 0; i--) {
        const prevId = session.previousCliSessionIds[i];
        const prevResult = await loadTranscript(prevId, session.info.cwd, { tailLines: 150 });
        if (prevResult.messages.length > 0) {
          const marker: ChatMessage = {
            id: "clear-boundary-" + Date.now(),
            role: "system" as const,
            content: "__context_reset__",
            toolUses: [],
            blocks: [],
            timestamp: Date.now(),
          };
          messages = [...prevResult.messages, marker, ...currentMessages];
          byteOffset = prevResult.byteOffset;
          lastUsage = lastUsage || prevResult.lastUsage;
          session.bufferCliSessionId = prevId;
          break;
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
    return { info: session.info, messages: clientMessages, hasMore, lastUsage };
  }

  async getSessionByCwd(
    id: string,
    cwd: string,
  ): Promise<{ info: SessionInfo; messages: ChatMessage[]; hasMore: boolean; lastUsage: { used: number; total: number } | null } | null> {
    this.ensureSession(id, cwd);
    const session = this.sessions.get(id)!;
    const result = await loadTranscript(session.cliSessionId, cwd, { tailLines: 150 });
    let { messages, byteOffset, totalSize, lastUsage } = result;

    session.bufferCliSessionId = session.cliSessionId;

    // Stitch previous session messages across /clear boundaries so the full
    // conversation is visible on refresh instead of only post-clear messages.
    const stitching = getDefaults().messageStitching;
    if (stitching && session.previousCliSessionIds.length > 0) {
      const currentMessages = messages;
      for (let i = session.previousCliSessionIds.length - 1; i >= 0; i--) {
        const prevId = session.previousCliSessionIds[i];
        const prevResult = await loadTranscript(prevId, cwd, { tailLines: 150 });
        if (prevResult.messages.length > 0) {
          const marker: ChatMessage = {
            id: "clear-boundary-" + Date.now(),
            role: "system" as const,
            content: "__context_reset__",
            toolUses: [],
            blocks: [],
            timestamp: Date.now(),
          };
          messages = [...prevResult.messages, marker, ...currentMessages];
          byteOffset = prevResult.byteOffset;
          lastUsage = lastUsage || prevResult.lastUsage;
          session.bufferCliSessionId = prevId;
          break;
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
    return { info: session.info, messages: clientMessages, hasMore, lastUsage };
  }

  async getCliSessionView(
    cliId: string,
    cwd: string,
  ): Promise<{ info: SessionInfo; messages: ChatMessage[]; hasMore: boolean; lastUsage: { used: number; total: number } | null } | null> {
    if (!transcriptExists(cliId, cwd)) return null;

    const chain = findChainForCliSession(cliId);
    const prevIds = chain ? chain.truncatedPrevIds : [];

    const result = await loadTranscript(cliId, cwd, { tailLines: 150 });
    let { messages, lastUsage } = result;

    if (getDefaults().messageStitching && prevIds.length > 0) {
      const currentMessages = messages;
      for (let i = prevIds.length - 1; i >= 0; i--) {
        const prevResult = await loadTranscript(prevIds[i], cwd, { tailLines: 150 });
        if (prevResult.messages.length > 0) {
          const marker: ChatMessage = {
            id: "clear-boundary-" + Date.now(),
            role: "system" as const,
            content: "__context_reset__",
            toolUses: [],
            blocks: [],
            timestamp: Date.now(),
          };
          messages = [...prevResult.messages, marker, ...currentMessages];
          lastUsage = lastUsage || prevResult.lastUsage;
          break;
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

    return {
      info: { id: cliId, name, cwd, createdAt: Date.now(), lastActiveAt: Date.now(), status: "idle" },
      messages: clientMessages,
      hasMore: messages.length > PAGE,
      lastUsage,
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

  listActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.process !== null)
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
    return !!session?.process;
  }

  hasRunningProcess(id: string): boolean {
    const session = this.sessions.get(id);
    return !!session?.process;
  }

  fixStaleStatus(id: string): void {
    const session = this.sessions.get(id);
    if (session && session.info.status === "running" && !session.process) {
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
    if (session.process) {
      this.endProcess(session, "session_destroyed");
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
    if (!session) return null;

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

  interrupt(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session?.process) {
      logDiag(id, "interrupt:no-process", { hasSession: !!session });
      return false;
    }

    // Pause the queue atomically with the interrupt so
    // flushQueuedMessage (called on message_done) becomes a no-op.
    // This prevents a race where message_done fires before a
    // separate pause_queue WS message can arrive.
    if (session.queuedMessages.length > 0) {
      session.queuePaused = true;
    }

    // Send a control_request interrupt via stdin instead of SIGINT.
    // SIGINT kills the process, forcing a full respawn + transcript reload
    // on the next message. The control_request interrupt aborts the current
    // turn but keeps the process alive so the next message can be sent
    // directly to stdin with no respawn overhead.
    if (session.stdin) {
      const request = {
        type: "control_request",
        request_id: `interrupt-${Date.now()}`,
        request: { subtype: "interrupt" },
      };
      logDiag(id, "interrupt:stdin", { requestId: request.request_id });
      session.stdin.write(JSON.stringify(request) + "\n");
      return true;
    }

    // Fallback: if stdin is gone, kill the process group
    logDiag(id, "interrupt:kill-fallback");
    this.killProcessGroup(session.process);
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
    if (!session?.stdin) return false;

    session.pendingRequests.delete(requestId);
    this.notifyPendingChanged(session, sessionId);

    const response = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: allowed
          ? {
              behavior: "allow" as const,
              ...(toolInput ? { updatedInput: toolInput } : {}),
              ...(permissionSuggestions?.length ? { updatedPermissions: permissionSuggestions } : {}),
            }
          : { behavior: "deny" as const, message: denyReason ?? "User denied" },
      },
    };

    session.stdin.write(JSON.stringify(response) + "\n");
    return true;
  }

  private sendPermissionMode(session: Session, sessionId: string, mode: string): void {
    if (!session.stdin) return;
    const request = {
      type: "control_request",
      request_id: `perm-${Date.now()}`,
      request: { subtype: "set_permission_mode", mode },
    };
    this.log(sessionId, `sending set_permission_mode: ${mode}`);
    session.stdin.write(JSON.stringify(request) + "\n");
  }

  setBypassAllPermissions(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.bypassAllPermissions) return;
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
    if (!session.process) return;
    if (session.info.status === "idle") {
      this.killProcess(session);
      session.hasSpawnedBefore = transcriptExists(session.cliSessionId, session.info.cwd);
    } else {
      session.needsRespawnForPermissions = true;
    }
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
    if (session.process) {
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
    if (session.process) {
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

  setModel(sessionId: string, model: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.info.model === model) return;

    // Detect 200K↔1M flip. The CLAUDE_CODE_DISABLE_1M_CONTEXT env var is
    // applied at spawn, so toggling the [1m] suffix mid-session needs a CLI
    // restart for the new context window to actually take effect.
    const has1m = (m: string | undefined) => !!m && /\[1m\]/i.test(m);
    const contextChanged = has1m(session.info.model) !== has1m(model);

    session.info.model = model;
    setSessionPrefs(sessionId, { model });

    const nextEntry = resolveModel(model);
    const coerced = coerceEffort(session.thinkingLevel, nextEntry);
    const levelChanged = coerced !== null && coerced !== session.thinkingLevel;
    if (levelChanged) {
      session.thinkingLevel = coerced;
      setSessionPrefs(sessionId, { thinkingLevel: coerced });
      this.emitSystem(session, sessionId, `__thinking_level::${coerced}`);
    }

    if (session.stdin && !contextChanged) {
      const request = {
        type: "control_request",
        request_id: `model-${Date.now()}`,
        request: { subtype: "set_model", model },
      };
      session.stdin.write(JSON.stringify(request) + "\n");
      if (allowedEffortLevels(nextEntry).length > 0) {
        const effortRequest = {
          type: "control_request",
          request_id: `effort-${Date.now()}`,
          request: { subtype: "apply_flag_settings", settings: { effort: session.thinkingLevel } },
        };
        session.stdin.write(JSON.stringify(effortRequest) + "\n");
      }
    } else {
      this.killProcess(session);
      session.queuedMessages.length = 0;
      session.queuePaused = false;
      session.info.status = "idle";
      session.emitter.emit("status", sessionId, "idle");
    }
    this.emitInfoUpdated(session, sessionId);
  }

  getModel(sessionId: string): string {
    return this.sessions.get(sessionId)?.info.model || "sonnet";
  }

  setThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.thinkingLevel === level) return;
    session.thinkingLevel = level;
    setSessionPrefs(sessionId, { thinkingLevel: level });

    const supportsEffort = allowedEffortLevels(resolveModel(session.info.model)).length > 0;
    if (session.stdin && supportsEffort) {
      const request = {
        type: "control_request",
        request_id: `effort-${Date.now()}`,
        request: { subtype: "apply_flag_settings", settings: { effort: level } },
      };
      session.stdin.write(JSON.stringify(request) + "\n");
    } else if (!session.stdin) {
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
    if (!session?.stdin) return Promise.reject(new Error("Session not connected"));

    const requestId = `ctrl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const msg = {
      type: "control_request",
      request_id: requestId,
      request,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.controlCallbacks.delete(requestId);
        reject(new Error("Control request timed out"));
      }, timeoutMs);

      session.controlCallbacks.set(requestId, (response) => {
        clearTimeout(timer);
        session.controlCallbacks.delete(requestId);
        resolve(response);
      });

      session.stdin!.write(JSON.stringify(msg) + "\n");
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

  private handleTodoWrite(session: Session, sessionId: string, toolInput: string): void {
    try {
      const input = JSON.parse(toolInput);
      const todos = input.todos;
      if (!Array.isArray(todos)) return;
      session.todoItems = todos
        .filter((t: Record<string, unknown>) => t.content && t.status)
        .map((t: Record<string, unknown>) => ({
          content: t.content as string,
          status: t.status as TodoItem["status"],
          activeForm: (t.activeForm as string) || undefined,
        }));
      session.emitter.emit("todos", sessionId, [...session.todoItems]);
    } catch {
      // invalid input, ignore
    }
  }

  rebuildTodosFromHistory(sessionId: string, messages: ChatMessage[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // If there's already a live todo state (set during the current process),
    // don't overwrite it from history.
    if (session.todoItems.length > 0) return;

    const todos = extractTodosFromHistory(messages);
    if (todos.length === 0) return;
    session.todoItems = todos;
    session.emitter.emit("todos", sessionId, [...session.todoItems]);
  }

  private extractUsage(session: Session, sessionId: string, line: string): void {
    try {
      const raw = JSON.parse(line.trim());

      if (raw.type === "result" && raw.modelUsage) {
        this.extractContextWindowSize(session, raw.modelUsage);
      }

      if (raw.type !== "assistant" || !raw.message?.usage) return;
      // Skip synthetic responses (e.g. /context) that have all-zero usage
      if (raw.message.model === "<synthetic>") return;
      const u = raw.message.usage;
      const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      const usage: ContextUsage = { used, total: session.contextWindowSize };
      session.contextUsage = usage;
      session.emitter.emit("usage", sessionId, usage);
    } catch {
      // not valid JSON, ignore
    }
  }

  private extractContextWindowSize(session: Session, modelUsage: Record<string, Record<string, number>>): void {
    for (const model of Object.values(modelUsage)) {
      if (model.contextWindow && model.contextWindow > 0) {
        session.contextWindowSize = model.contextWindow;
        return;
      }
    }
  }

  private killProcessGroup(proc: ChildProcess): void {
    if (!proc.pid) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(-proc.pid, "SIGTERM");
      }
    } catch {}
  }

  // Graceful shutdown: send end_session control request via stdin.
  // The CLI aborts any in-flight API call, cleans up, acks, then exits.
  // Falls back to SIGTERM if the process doesn't exit within the timeout.
  private endProcess(session: Session, reason?: string): void {
    if (!session.process) return;
    const proc = session.process;

    if (session.stdin) {
      const request = {
        type: "control_request",
        request_id: `end-session-${Date.now()}`,
        request: { subtype: "end_session", reason },
      };
      session.stdin.write(JSON.stringify(request) + "\n");

      // Fallback: SIGTERM if the CLI doesn't exit within 3 seconds
      const fallback = setTimeout(() => {
        this.killProcessGroup(proc);
      }, 3000);
      proc.once("close", () => clearTimeout(fallback));
    } else {
      this.killProcessGroup(proc);
    }
  }

  private killProcess(session: Session): void {
    if (session.process) {
      session.process.on("close", () => {});
      this.endProcess(session, "session_reset");
      session.process = null;
      session.stdin = null;
    }
    session.compacting = false;
  }

  private emitSystem(session: Session, sessionId: string, text: string): void {
    session.emitter.emit("system", sessionId, text);
  }

  private notifyPendingChanged(session: Session, sessionId: string): void {
    const count = session.pendingRequests.size;
    if (session.info.pendingRequestCount === count) return;
    session.info.pendingRequestCount = count;
    session.emitter.emit("pending", sessionId, count);
  }

  private applyProcessedResult(session: Session, sessionId: string, result: import("./stream-processor").ProcessedResult): void {
    for (const msg of result.intermediateMessages) {
      session.emitter.emit("event", sessionId, { type: "message_done", message: msg } as ParsedEvent);
      if (msg.toolUses.some((t: ToolUse) => t.name === "Agent")) {
        this.loadAgentChildren(session, sessionId, msg.id, session.info.cwd);
      }
    }

    for (const sysMsg of result.systemMessages) {
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

    for (const todoInput of result.todoInputs) {
      this.handleTodoWrite(session, sessionId, todoInput);
    }

    for (const pa of result.permissionActions) {
      if (pa.type === "auto_approve") {
        this.respondToPermission(sessionId, pa.requestId, true, pa.rawToolInput);
      } else if (pa.type === "auto_deny") {
        this.respondToPermission(sessionId, pa.requestId, false, undefined, undefined, pa.denyReason);
      } else if (session.bypassAllPermissions && !session.planMode) {
        // CLI was spawned without bypass capability (e.g. after exiting plan
        // mode) but the session has bypass enabled. Auto-approve server-side
        // until the process respawns with the right flags.
        this.respondToPermission(sessionId, pa.requestId, true, pa.rawToolInput);
      } else {
        const planPath = pa.toolName === "ExitPlanMode" ? findLatestPlanFile() : undefined;
        session.pendingRequests.set(pa.requestId, {
          type: pa.toolName === "AskUserQuestion" ? "question" : "permission",
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
    }

    if (result.emit.length > 0) {
      const listeners = session.emitter.listenerCount("event");
      if (listeners === 0) {
        smLog(sessionId, `applyProcessedResult: ${result.emit.length} events but 0 event listeners`);
      }
    }
    for (const event of result.emit) {
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
    }

    if (result.statusChange === "idle") {
      session.info.status = "idle";
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
        session.hasSpawnedBefore = false;
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
        this.killProcess(session);
        session.info.model = args;
        session.info.status = "idle";
        session.emitter.emit("status", sessionId, "idle");
        setSessionPrefs(sessionId, { model: args });
        this.emitSystem(session, sessionId, `Model switched to ${args}`);
        this.emitInfoUpdated(session, sessionId);
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
          "  /help                 - Show this help message",
          "",
          "All other slash commands (/compact, /cost, /context, /commit,",
          "/review, /analyze, etc.) are passed directly to Claude.",
        ].join("\n");
        this.emitSystem(session, sessionId, helpText);
        return true;
      }
    }

    // All other slash commands pass through to Claude
    return false;
  }

  private buildContent(
    session: Session,
    text: string,
    images?: ImageAttachment[],
    documents?: DocumentAttachment[],
  ): string | Record<string, unknown>[] {
    const reminder = session.pendingPlanReminder ? this.planModeReminderText() : null;
    if (session.pendingPlanReminder) session.pendingPlanReminder = false;

    if (!images?.length && !documents?.length && !reminder) return text;

    const blocks: Record<string, unknown>[] = [];
    if (reminder) blocks.push({ type: "text", text: reminder });
    for (const img of images ?? []) {
      blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
    }
    for (const doc of documents ?? []) {
      blocks.push({ type: "document", source: { type: "base64", media_type: doc.mediaType, data: doc.data } });
    }
    if (text) blocks.push({ type: "text", text });
    return blocks;
  }

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

  async recoverSession(id: string): Promise<boolean> {
    if (this.sessions.has(id)) return true;
    smLog(id, "recovering session: not in memory, searching disk");
    const prefs = getSessionPrefs(id);
    const cwd = (await findSessionCwd(prefs?.cliSessionId || id)) || (await findSessionCwd(id));
    if (!cwd) {
      smLog(id, "recovery failed: no transcript found on disk");
      return false;
    }
    this.ensureSession(id, cwd);
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
      if (session.process && session.stdin) {
        const compactInput = { type: "user", message: { role: "user", content: "/compact" } };
        session.stdin.write(JSON.stringify(compactInput) + "\n");
      } else {
        this.spawnProcess(session, sessionId, "/compact");
      }
      return true;
    }

    const content = this.buildContent(session, text, images, documents);

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

    logDiag(sessionId, "running:send", { hasProcess: !!session.process, hasStdin: !!session.stdin });
    session.info.status = "running";
    session.emitter.emit("status", sessionId, "running");

    if (session.process && session.stdin) {
      if (session.streamState) session.streamState.thinkingStartedAt = Date.now();
      const userInput = { type: "user", message: { role: "user", content } };
      session.stdin.write(JSON.stringify(userInput) + "\n");
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
    if (!session || session.process) return;
    this.spawnProcess(session, sessionId);
  }

  private spawnProcess(
    session: Session,
    sessionId: string,
    text?: string,
    images?: ImageAttachment[],
    documents?: DocumentAttachment[],
  ): void {
    this.log(sessionId, `spawning CLI process (resume=${session.hasSpawnedBefore}, model=${session.info.model || "sonnet"})`);
    const args = ["-p", "--verbose", "--output-format", "stream-json", "--input-format", "stream-json"];

    // In plan mode, omit --allow-dangerously-skip-permissions so the CLI
    // natively enforces tool restrictions and sends permission_requests for
    // write tools (which the server auto-denies).
    // Outside plan mode, enable bypass so it can be toggled mid-session.
    if (!session.planMode) {
      args.push("--allow-dangerously-skip-permissions");
    }
    args.push("--permission-prompt-tool", "stdio");

    if (session.planMode) {
      args.push("--permission-mode", "plan");
    } else if (session.bypassAllPermissions) {
      args.push("--permission-mode", "bypassPermissions");
    }

    if (session.hasSpawnedBefore || transcriptExists(session.cliSessionId, session.info.cwd)) {
      args.push("--resume", session.cliSessionId);
    } else {
      args.push("--session-id", session.cliSessionId);
    }

    if (session.info.model) {
      args.push("--model", session.info.model);
    }

    if (allowedEffortLevels(resolveModel(session.info.model)).length > 0) {
      args.push("--effort", session.thinkingLevel);
    }

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    // Claude Code defaults to a model's full context window (1M for Opus 4.7,
    // Sonnet 4.6) when no [1m] suffix is present, ignoring the suffix as the
    // gate. CLAUDE_CODE_DISABLE_1M_CONTEXT is the only switch that forces 200K
    // back regardless of model capability — set it when the user picked 200K.
    if (session.info.model && !/\[1m\]/i.test(session.info.model)) {
      env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
    }

    mkdirSync(session.info.cwd, { recursive: true });

    const isWin = process.platform === "win32";
    const proc = spawn("claude", args, {
      cwd: session.info.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ...(isWin ? { shell: true } : { detached: true }),
    });

    session.process = proc;
    session.stdin = proc.stdin!;
    session.hasSpawnedBefore = true;
    this.log(sessionId, `CLI process spawned (pid=${proc.pid})`);

    // Send initialize control request before the first user message to get
    // model capabilities, account info, and command metadata from the CLI.
    const initRequest = {
      type: "control_request",
      request_id: `init-${Date.now()}`,
      request: { subtype: "initialize" },
    };
    proc.stdin!.write(JSON.stringify(initRequest) + "\n");

    // Sync permission mode after init so the CLI matches session state,
    // even if --permission-mode was ignored on resume.
    if (session.planMode) {
      this.sendPermissionMode(session, sessionId, "plan");
    } else if (session.bypassAllPermissions) {
      this.sendPermissionMode(session, sessionId, "bypassPermissions");
    }

    if (text) {
      const content = this.buildContent(session, text, images, documents);
      const userInput = { type: "user", message: { role: "user", content } };
      proc.stdin!.write(JSON.stringify(userInput) + "\n");
    }

    // Handle pipe errors to prevent unhandled exceptions
    proc.stdin!.on("error", (err) => {
      this.log(sessionId, `stdin pipe error: ${err.message}`);
    });
    proc.stdout!.on("error", (err) => {
      this.log(sessionId, `stdout pipe error: ${err.message}`);
    });
    proc.stderr!.on("error", (err) => {
      this.log(sessionId, `stderr pipe error: ${err.message}`);
    });

    const parser = new EventParser();
    let stderrBuffer = "";
    const streamState = createStreamState();
    session.streamState = streamState;
    streamState.thinkingStartedAt = Date.now();

    let lineBuffer = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || "";

      if (lineBuffer.trimStart().startsWith("{") && lineBuffer.trimEnd().endsWith("}")) {
        try {
          JSON.parse(lineBuffer);
          lines.push(lineBuffer);
          lineBuffer = "";
        } catch {
          // incomplete JSON, keep buffering
        }
      }

      for (const line of lines) {
        logRawLine(sessionId, line);

        if (session.controlCallbacks.size > 0 && line.includes('"control_response"')) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "control_response" && parsed.request_id) {
              const cb = session.controlCallbacks.get(parsed.request_id);
              if (cb) {
                cb(parsed.response || parsed);
                continue;
              }
            }
          } catch {
            // not valid JSON, fall through to normal processing
          }
        }

        if (streamState.agentStack.length === 0) {
          this.extractUsage(session, sessionId, line);
        }
        const events = parser.parseLine(line);
        const result = processEvents(events, streamState, { planMode: session.planMode, compacting: session.compacting });
        this.applyProcessedResult(session, sessionId, result);
      }
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    proc.on("close", (code, signal) => {
      this.log(sessionId, `CLI process exited (code=${code}, signal=${signal}, pid=${proc.pid})`);

      if (session.process !== null && session.process !== proc) {
        this.log(sessionId, `skipping close cleanup: newer process already running (pid=${session.process.pid})`);
        return;
      }

      if (lineBuffer.trim()) {
        const events = parser.parseLine(lineBuffer);
        const result = processEvents(events, streamState, { planMode: session.planMode, compacting: session.compacting });
        this.applyProcessedResult(session, sessionId, result);
      }

      session.process = null;
      session.stdin = null;
      session.streamingSnapshot = null;
      logDiag(sessionId, "idle:process-close", { code, flushedOnMessageDone: streamState.flushedOnMessageDone });
      session.info.status = "idle";
      session.emitter.emit("status", sessionId, "idle");

      if (session.compacting) {
        logDiag(sessionId, "compact:done-on-close");
        session.compacting = false;
        this.emitSystem(session, sessionId, "__compact::done");
      }

      if (session.todoItems.length > 0 && session.todoItems.every((t) => t.status === "completed")) {
        session.todoItems = [];
        session.emitter.emit("todos", sessionId, []);
      }

      if (code !== 0 && stderrBuffer.trim()) {
        session.emitter.emit("error", sessionId, stderrBuffer.trim());
      }

      if (!streamState.flushedOnMessageDone) {
        this.flushQueuedMessage(session, sessionId);
      }
    });

    proc.on("error", (err) => {
      this.log(sessionId, `CLI process error: ${err.message}`);
      logDiag(sessionId, "idle:process-error", { error: err.message });
      session.process = null;
      session.stdin = null;
      session.info.status = "idle";
      session.emitter.emit("status", sessionId, "idle");
      session.emitter.emit("error", sessionId, err.message);
      this.flushQueuedMessage(session, sessionId);
    });
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

const MCP_CACHE_PATH = path.join(homedir(), ".cockpit", "mcp-servers.json");

function loadMcpServerCache(): string[] {
  try {
    if (!existsSync(MCP_CACHE_PATH)) return [];
    return JSON.parse(readFileSync(MCP_CACHE_PATH, "utf-8")) as string[];
  } catch {
    return [];
  }
}

function saveMcpServerCache(servers: string[]): void {
  try {
    const dir = path.dirname(MCP_CACHE_PATH);
    mkdirSync(dir, { recursive: true });
    writeFileSync(MCP_CACHE_PATH, JSON.stringify(servers));
  } catch {
    // best-effort
  }
}

// Walk messages newest-first, stop at the most recent /clear boundary, and
// pull todos from the last TodoWrite call. Pure function so the history-view
// branch can use it without an in-memory session.
export function extractTodosFromHistory(messages: ChatMessage[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "system" && msg.content === "__compacted__") return [];
    if (msg.role !== "assistant") continue;
    for (let j = msg.toolUses.length - 1; j >= 0; j--) {
      if (msg.toolUses[j].name !== "TodoWrite") continue;
      try {
        const input = JSON.parse(msg.toolUses[j].input);
        if (!Array.isArray(input.todos)) return [];
        return input.todos
          .filter((t: Record<string, unknown>) => t.content && t.status)
          .map((t: Record<string, unknown>) => ({
            content: t.content as string,
            status: t.status as TodoItem["status"],
            activeForm: (t.activeForm as string) || undefined,
          }));
      } catch {
        return [];
      }
    }
  }
  return [];
}
