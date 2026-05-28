import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type Writable } from "node:stream";
import { v4 as uuidv4 } from "uuid";
import {
  allowedEffortLevels,
  CONTEXT_SIZES,
  type ContextSize,
  coerceEffort,
  DEFAULT_CONTEXT_SIZE,
  recommendedEffort,
  resolveModel,
} from "@/lib/models";
import { resolveProviderModel } from "@/server/providers";
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
import { EventParser, type ParsedEvent } from "./event-parser";
import { findLatestPlanFile, readPlanFile } from "./plans";
import { PtyRuntime } from "./pty-runtime";
import { findChainForCliSession, getSessionPrefs, type SessionRuntime, setSessionPrefs } from "./session-prefs";
import { getHookRouter } from "./singleton";
import { createStreamState, processEvents, type StreamState } from "./stream-processor";
import { TodoWatcher } from "./todo-watcher";
import { findSessionCwd, loadMoreMessages, loadPromptHistory, loadTranscript, transcriptExists } from "./transcript";
import { TranscriptWatcher } from "./transcript-watcher";

export type { SessionRuntime };

function defaultRuntime(): SessionRuntime {
  return "stream";
}

let resolvedClaudeBin: string | null = null;
function getClaudeBin(): string {
  if (resolvedClaudeBin) return resolvedClaudeBin;
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    resolvedClaudeBin = execFileSync(cmd, ["claude"], { encoding: "utf-8" }).trim().split("\n")[0];
  } catch {
    resolvedClaudeBin = "claude";
  }
  return resolvedClaudeBin;
}

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
  ptyRuntime: PtyRuntime | null;
  transcriptWatcher: TranscriptWatcher | null;
  todoWatcher: TodoWatcher | null;
  attachmentPaths: string[];
  /** Cumulative token counts for the current session (used by /cost). */
  totalTokens: { input: number; output: number; cacheCreate: number; cacheRead: number };
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  constructor() {
    // Periodically check for sessions stuck in "running" with a dead process
    setInterval(() => {
      for (const [id, session] of this.sessions) {
        if (session.info.status === "running" && !session.process && !session.ptyRuntime?.isAlive) {
          const short = id.slice(0, 8);
          debugLog(`[session:${short}] stale check: status=running but no live process, correcting to idle`);
          logDiag(id, "idle:stale-check");
          session.info.status = "idle";
          session.emitter.emit("status", id, "idle");
        }
      }
    }, 15000);
  }

  createSession(cwd: string, name?: string, options?: { bypassPermissions?: boolean; runtime?: SessionRuntime }): SessionInfo {
    const id = uuidv4();
    const now = Date.now();
    const defaults = getDefaults();
    const modelSlots: ModelSlots = { main: defaults.modelSlots.main ?? "sonnet" };
    const rt = options?.runtime ?? defaultRuntime();
    const info: SessionInfo = {
      id,
      name: name || path.basename(cwd) || cwd,
      cwd,
      createdAt: now,
      lastActiveAt: now,
      status: "idle",
      model: modelSlots.main,
      runtime: rt,
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
      modelSlots,
      transcriptBuffer: [],
      transcriptByteOffset: 0,
      transcriptTotalSize: 0,
      bufferCliSessionId: id,
      paginationPrevIds: [],
      runtime: rt,
      ptyRuntime: null,
      transcriptWatcher: null,
      todoWatcher: null,
      attachmentPaths: [],
      totalTokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    });

    setSessionPrefs(id, { runtime: rt });

    return info;
  }

  ensureSession(id: string, cwd: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      const prefs = getSessionPrefs(id);
      const cliId = prefs?.cliSessionId || id;
      const prevIds = prefs?.previousCliSessionIds || [];
      const short = id.slice(0, 8);
      debugLog(
        `[session:${short}] ensureSession: cliSessionId=${cliId.slice(0, 8)}, prevIds=[${prevIds.map((p) => p.slice(0, 8)).join(",")}], hasPrefs=${!!prefs}`,
      );
      const defaults = getDefaults();
      const now = Date.now();
      const modelSlots: ModelSlots =
        prefs?.modelSlots ?? (prefs?.model ? { main: prefs.model } : { main: defaults.modelSlots.main ?? "sonnet" });
      const restoredRuntime = prefs?.runtime ?? defaultRuntime();
      session = {
        info: {
          id,
          name: prefs?.name || path.basename(cwd) || cwd,
          cwd,
          createdAt: now,
          lastActiveAt: now,
          status: "idle",
          model: modelSlots.main,
          runtime: restoredRuntime,
          pendingRequestCount: 0,
        },
        process: null,
        stdin: null,
        emitter: new EventEmitter(),
        hasSpawnedBefore: true,
        cliSessionId: cliId,
        previousCliSessionIds: prevIds,
        bypassAllPermissions: prefs?.bypassAllPermissions ?? defaults.bypassAllPermissions,
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
        contextWindowSize: 200_000,
        todoItems: [],
        pendingRequests: new Map(),
        controlCallbacks: new Map(),
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
        ptyRuntime: null,
        transcriptWatcher: null,
        todoWatcher: null,
        attachmentPaths: [],
        totalTokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
      };
      this.sessions.set(id, session);
    }
    return session!;
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

    return { info: session.info, messages: clientMessages, hasMore, lastUsage, promptHistory: allPrompts };
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

    return { info: session.info, messages: clientMessages, hasMore, lastUsage, promptHistory: allPrompts };
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

    return {
      info: { id: cliId, name, cwd, createdAt: Date.now(), lastActiveAt: Date.now(), status: "idle" },
      messages: clientMessages,
      hasMore: messages.length > PAGE,
      lastUsage,
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
      .filter((s) => s.process !== null || !!s.ptyRuntime?.isAlive)
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
    return !!session?.process || !!session?.ptyRuntime?.isAlive;
  }

  hasRunningProcess(id: string): boolean {
    const session = this.sessions.get(id);
    return !!session?.process || !!session?.ptyRuntime?.isAlive;
  }

  fixStaleStatus(id: string): void {
    const session = this.sessions.get(id);
    if (session && session.info.status === "running" && !session.process && !session.ptyRuntime?.isAlive) {
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
    if (!transcriptExists(session.cliSessionId, session.info.cwd)) {
      session.hasSpawnedBefore = false;
    }
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
    if (session.ptyRuntime) {
      const runtime = session.ptyRuntime;
      session.ptyRuntime = null;
      runtime.kill().catch(() => {});
    }
    if (session.transcriptWatcher) {
      session.transcriptWatcher.stop();
      session.transcriptWatcher = null;
    }
    if (session.todoWatcher) {
      session.todoWatcher.stop();
      session.todoWatcher = null;
    }
    this.cleanupAttachments(session);
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

    if (session.runtime === "pty") {
      if (!session.ptyRuntime?.isAlive) {
        logDiag(id, "interrupt:no-pty");
        return false;
      }
      logDiag(id, "interrupt:pty-esc");
      session.ptyRuntime.interrupt();
      // Esc cancels the claude TUI turn but may not produce a Stop hook if it
      // arrived before any response. Force-idle so the UI unsticks; the PTY
      // process stays alive at its REPL prompt and accepts the next message.
      if (session.info.status === "running") {
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

    if (!session.process) {
      logDiag(id, "interrupt:no-process", { hasSession: true });
      return false;
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
      session.pendingRequests.clear();
      this.notifyPendingChanged(session, id);
      return true;
    }

    // Fallback: if stdin is gone, kill the process group
    logDiag(id, "interrupt:kill-fallback");
    this.killProcessGroup(session.process);
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
      const had = session.pendingRequests.has(requestId);
      const wasQuestion = session.pendingRequests.get(requestId)?.type === "question";
      session.pendingRequests.delete(requestId);
      if (wasQuestion) {
        console.log(
          `[question-debug] removePendingRequest: session=${sessionId.slice(0, 8)}, requestId=${requestId}, existed=${had}, remaining=${session.pendingRequests.size}`,
        );
      }
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
    if (!session) return false;

    if (session.runtime === "pty") {
      if (!session.ptyRuntime?.isAlive) return false;
      session.pendingRequests.delete(requestId);
      this.notifyPendingChanged(session, sessionId);
      return session.ptyRuntime.notifyPermissionDecision(
        requestId,
        allowed
          ? { behavior: "allow", ...(toolInput ? { updatedInput: toolInput } : {}) }
          : { behavior: "deny", message: denyReason ?? "User denied" },
      );
    }

    if (!session.stdin) return false;

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
              updatedInput: toolInput ?? {},
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
    if (!session.process && !session.ptyRuntime?.isAlive) return;
    if (session.info.status === "idle") {
      this.killProcess(session);
      session.hasSpawnedBefore = transcriptExists(session.cliSessionId, session.info.cwd);
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
    if (session.process || session.ptyRuntime?.isAlive) {
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
    if (session.process || session.ptyRuntime?.isAlive) {
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
      `setModel: requested=${model} size=${contextSize ?? "(unspecified)"}, current=${session?.info.model} currentSize=${session?.info.contextSize ?? "(unset)"}, hasStdin=${!!session?.stdin}, hasPty=${!!session?.ptyRuntime}`,
    );
    if (!session) return;

    const currentSize = session.info.contextSize ?? DEFAULT_CONTEXT_SIZE;
    const requestedSize = contextSize ?? currentSize;
    const resolvedSize: ContextSize = (() => {
      const sizes = resolveModel(model)?.contextSizes;
      if (!sizes || sizes.length === 0) return requestedSize;
      return sizes.includes(requestedSize) ? requestedSize : sizes[0];
    })();
    // Detect 200K<->1M flip via the explicit contextSize field. The
    // CLAUDE_CODE_DISABLE_1M_CONTEXT env var is applied at spawn, so toggling
    // the context size mid-session needs a CLI restart for the new context
    // window to actually take effect.
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
          if (levels.includes(session.thinkingLevel)) return session.thinkingLevel;
          return levels[levels.length - 1];
        })();
    const levelChanged = coerced !== null && coerced !== session.thinkingLevel;
    if (levelChanged) {
      session.thinkingLevel = coerced;
      setSessionPrefs(sessionId, { thinkingLevel: coerced });
      this.emitSystem(session, sessionId, `__thinking_level::${coerced}`);
    }

    if (session.stdin && !contextChanged) {
      this.log(sessionId, `setModel: sending control_request set_model=${model}`);
      const request = {
        type: "control_request",
        request_id: `model-${Date.now()}`,
        request: { subtype: "set_model", model },
      };
      session.stdin.write(JSON.stringify(request) + "\n");
      if (this.modelEffortLevels(model).length > 0) {
        const effortRequest = {
          type: "control_request",
          request_id: `effort-${Date.now()}`,
          request: { subtype: "apply_flag_settings", settings: { effort: session.thinkingLevel } },
        };
        session.stdin.write(JSON.stringify(effortRequest) + "\n");
      }
    } else {
      this.log(sessionId, `setModel: killing process (hasStdin=${!!session.stdin}, contextChanged=${contextChanged})`);
      this.killProcess(session);
      if (!transcriptExists(session.cliSessionId, session.info.cwd)) {
        session.hasSpawnedBefore = false;
      }
      session.queuedMessages.length = 0;
      session.queuePaused = false;
      session.info.status = "idle";
      session.emitter.emit("status", sessionId, "idle");
    }
    this.emitInfoUpdated(session, sessionId);
    // Sync the contextWindowSize when the model changes. Without this, the
    // context indicator shows the old total (e.g. 1000K) after switching to
    // a model with a different context window (e.g. 200K Flash) until the
    // CLI respawns and reports the actual value.
    if (contextChanged) {
      session.contextWindowSize = resolvedSize === "1m" ? 1_000_000 : (nextEntry?.contextWindow ?? 200_000);
    }
    const cur = session.contextUsage;
    if (cur) {
      session.emitter.emit("usage", sessionId, { used: cur.used, total: session.contextWindowSize });
    }
  }

  setModelSlot(sessionId: string, slot: "main" | "subagent" | "fast", modelId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const slots = { ...session.modelSlots };
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

  setThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.thinkingLevel === level) return;
    session.thinkingLevel = level;
    setSessionPrefs(sessionId, { thinkingLevel: level });

    const supportsEffort = this.modelEffortLevels(session.info.model).length > 0;
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
      session.totalTokens.input += u.input_tokens || 0;
      session.totalTokens.output += u.output_tokens || 0;
      session.totalTokens.cacheCreate += u.cache_creation_input_tokens || 0;
      session.totalTokens.cacheRead += u.cache_read_input_tokens || 0;
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
    if (session.ptyRuntime) {
      const runtime = session.ptyRuntime;
      session.ptyRuntime = null;
      runtime.kill().catch(() => {});
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
      if (sysMsg === "__compact::hook_done") {
        if (session.compacting) {
          logDiag(sessionId, "compact:hook-done");
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
      } else if (session.bypassAllPermissions && !session.planMode && pa.toolName !== "AskUserQuestion") {
        this.respondToPermission(sessionId, pa.requestId, true, pa.rawToolInput);
        bypassedRequestIds.add(pa.requestId);
      } else {
        const planPath = pa.toolName === "ExitPlanMode" ? findLatestPlanFile() : undefined;
        const reqType = pa.toolName === "AskUserQuestion" ? "question" : "permission";
        if (reqType === "question") {
          console.log(
            `[question-debug] adding pending question: session=${sessionId.slice(0, 8)}, requestId=${pa.requestId}, total=${session.pendingRequests.size + 1}`,
          );
        }
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
    }

    if (result.statusChange === "idle") {
      session.info.status = "idle";
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
        this.log(sessionId, `/model command: args="${args}", was=${session.info.model}`);
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

    // In PTY mode, intercept commands that render CLI dialogs to prevent hangs
    if (session.ptyRuntime?.isAlive) {
      const dialogCmd = cmd.replace("/", "");
      if (SessionManager.DIALOG_COMMANDS.has(dialogCmd)) {
        this.emitSystem(session, sessionId, `"${cmd}" opens an interactive CLI dialog that isn't available in remote mode.`);
        return true;
      }
    }

    // All other slash commands pass through to Claude
    return false;
  }

  private static readonly DIALOG_COMMANDS = new Set([
    "config",
    "usage",
    "session",
    "stats",
    "doctor",
    "diff",
    "mcp",
    "permissions",
    "hooks",
    "tasks",
    "agents",
    "skills",
    "memory",
    "theme",
    "fast",
    "feedback",
    "copy",
    "branch",
    "plan",
    "chrome",
    "desktop",
    "ide",
    "mobile",
    "bridge",
    "sandbox",
    "export",
    "login",
    "logout",
    "upgrade",
    "rate-limit-options",
    "privacy-settings",
    "terminal-setup",
    "install-github-app",
    "remote-env",
    "remote-setup",
    "resume",
    "add-dir",
    "btw",
    "extra-usage",
    "passes",
    "think-back",
    "ultrareview",
    "tag",
    "exit",
    "effort",
    "color",
    "files",
  ]);

  private static readonly MEDIA_EXT: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
  };

  private writeAttachments(images?: ImageAttachment[], documents?: DocumentAttachment[]): string[] {
    if (!images?.length && !documents?.length) return [];
    const dir = path.join(homedir(), ".cache", "cockpit", "attachments");
    mkdirSync(dir, { recursive: true });
    const paths: string[] = [];
    for (const img of images ?? []) {
      const ext = SessionManager.MEDIA_EXT[img.mediaType] || ".png";
      const p = path.join(dir, `${uuidv4()}${ext}`);
      writeFileSync(p, Buffer.from(img.data, "base64"));
      paths.push(p);
    }
    for (const doc of documents ?? []) {
      const ext = SessionManager.MEDIA_EXT[doc.mediaType] || ".pdf";
      const p = path.join(dir, `${uuidv4()}${ext}`);
      writeFileSync(p, Buffer.from(doc.data, "base64"));
      paths.push(p);
    }
    return paths;
  }

  private cleanupAttachments(session: Session): void {
    for (const p of session.attachmentPaths) {
      try {
        unlinkSync(p);
      } catch {
        // file already cleaned up
      }
    }
    session.attachmentPaths = [];
  }

  private buildPtyText(text: string, attachmentPaths: string[]): string {
    if (attachmentPaths.length === 0) return text;
    const refs = attachmentPaths.map((p) => `[Attached image: ${p}]`).join("\n");
    return `${refs}\n${text}`;
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
      if (session.ptyRuntime?.isAlive) {
        session.ptyRuntime.sendText("/compact").catch(() => {});
      } else if (session.process && session.stdin) {
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

    logDiag(sessionId, "running:send", {
      hasProcess: !!session.process,
      hasStdin: !!session.stdin,
      runtime: session.runtime,
      ptyAlive: !!session.ptyRuntime?.isAlive,
    });
    session.info.status = "running";
    console.log(`[sm] emit status running for ${sessionId.slice(0, 8)} (runtime=${session.runtime})`);
    session.emitter.emit("status", sessionId, "running");

    if (session.runtime === "pty" && session.ptyRuntime?.isAlive) {
      if (session.streamState) session.streamState.thinkingStartedAt = Date.now();
      this.cleanupAttachments(session);
      const attachments = this.writeAttachments(images, documents);
      session.attachmentPaths.push(...attachments);
      const ptyText = this.buildPtyText(text, attachments);
      session.ptyRuntime.sendText(ptyText).catch((err) => {
        this.log(sessionId, `pty sendText failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      return true;
    }

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
    if (!session || session.process || session.ptyRuntime?.isAlive) return;
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
    if (session.runtime === "pty") {
      this.spawnPtyProcess(session, sessionId, text, images, documents);
      return;
    }

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

    const resolved = resolveProviderModel(session.info.model ?? "sonnet");
    const cliModel = resolved ? resolved.model.modelId : session.info.model;
    this.log(
      sessionId,
      `spawn: info.model=${session.info.model}, resolved=${resolved ? `${resolved.provider.id}:${resolved.model.modelId}` : "null"}, cliModel=${cliModel}`,
    );

    if (cliModel) {
      args.push("--model", cliModel);
    }

    if (this.modelEffortLevels(session.info.model).length > 0) {
      args.push("--effort", session.thinkingLevel);
    }

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    if (resolved) {
      Object.assign(env, resolved.provider.envVars);
    }

    // CLAUDE_CODE_DISABLE_1M_CONTEXT is the only switch that forces a model
    // back to 200K regardless of its capability. Set it when the user picked
    // 200K for this session.
    const sizeKey = session.info.contextSize ?? DEFAULT_CONTEXT_SIZE;
    if (CONTEXT_SIZES[sizeKey].disableEnv) {
      env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
    }

    if (session.modelSlots.subagent && session.modelSlots.subagent !== session.modelSlots.main) {
      const resolvedSub = resolveProviderModel(session.modelSlots.subagent);
      env.ANTHROPIC_SMALL_FAST_MODEL = resolvedSub ? resolvedSub.model.modelId : session.modelSlots.subagent;
    }

    mkdirSync(session.info.cwd, { recursive: true });

    const isWin = process.platform === "win32";
    const proc = spawn(getClaudeBin(), args, {
      cwd: session.info.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ...(isWin ? { shell: true } : { detached: true }),
    });

    session.process = proc;
    session.stdin = proc.stdin!;
    session.hasSpawnedBefore = true;
    this.log(sessionId, `CLI process spawned (pid=${proc.pid})`);

    this.startTodoWatcher(session, sessionId);

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

  private spawnPtyProcess(
    session: Session,
    sessionId: string,
    text?: string,
    images?: ImageAttachment[],
    documents?: DocumentAttachment[],
  ): void {
    if (session.ptyRuntime?.isAlive) {
      const existing = session.ptyRuntime;
      session.ptyRuntime = null;
      existing.kill().catch(() => {});
    }

    const hookRouter = getHookRouter();
    if (!hookRouter) {
      const msg = "PTY runtime requires the hook router; server boot did not register one";
      this.log(sessionId, msg);
      session.info.status = "idle";
      session.emitter.emit("status", sessionId, "idle");
      session.emitter.emit("error", sessionId, msg);
      return;
    }

    this.log(sessionId, `spawning PTY claude (resume=${session.hasSpawnedBefore}, model=${session.info.model || "sonnet"})`);
    mkdirSync(session.info.cwd, { recursive: true });

    const streamState = createStreamState();
    session.streamState = streamState;
    streamState.thinkingStartedAt = Date.now();

    const extraArgs: string[] = [];
    if (session.hasSpawnedBefore || transcriptExists(session.cliSessionId, session.info.cwd)) {
      extraArgs.push("--resume", session.cliSessionId);
    } else {
      extraArgs.push("--session-id", session.cliSessionId);
    }
    const resolvedPty = resolveProviderModel(session.info.model ?? "sonnet");
    const cliModelPty = resolvedPty ? resolvedPty.model.modelId : session.info.model;
    if (cliModelPty) extraArgs.push("--model", cliModelPty);
    if (this.modelEffortLevels(session.info.model).length > 0) {
      extraArgs.push("--effort", session.thinkingLevel);
    }
    if (session.planMode) {
      extraArgs.push("--permission-mode", "plan");
    } else if (session.bypassAllPermissions) {
      extraArgs.push("--permission-mode", "bypassPermissions");
    }

    const extraEnv: Record<string, string> = {};
    if (resolvedPty) Object.assign(extraEnv, resolvedPty.provider.envVars);
    const sizeKeyPty = session.info.contextSize ?? DEFAULT_CONTEXT_SIZE;
    if (CONTEXT_SIZES[sizeKeyPty].disableEnv) {
      extraEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
    }
    if (session.modelSlots.subagent && session.modelSlots.subagent !== session.modelSlots.main) {
      const resolvedSub = resolveProviderModel(session.modelSlots.subagent);
      extraEnv.ANTHROPIC_SMALL_FAST_MODEL = resolvedSub ? resolvedSub.model.modelId : session.modelSlots.subagent;
    }

    const runtime = new PtyRuntime({
      sessionId,
      cwd: session.info.cwd,
      cliSessionId: session.cliSessionId,
      hookRouter,
      claudeBin: getClaudeBin(),
      extraArgs,
      extraEnv,
      onEvents: (events) => {
        const types = events.map((e) => e.type).join(", ");
        console.log(`[sm] pty onEvents for ${sessionId.slice(0, 8)}: [${types}]`);
        const result = processEvents(events, streamState, { planMode: session.planMode, compacting: session.compacting });
        this.applyProcessedResult(session, sessionId, result);
      },
      onError: (err) => {
        this.log(sessionId, `pty runtime error: ${err}`);
        session.emitter.emit("error", sessionId, err);
      },
      onExit: ({ exitCode, signal }) => {
        this.log(sessionId, `PTY claude exited (code=${exitCode}, signal=${signal ?? "none"})`);
        if (session.ptyRuntime !== runtime) return;
        session.ptyRuntime = null;
        session.streamingSnapshot = null;
        logDiag(sessionId, "idle:pty-exit", { exitCode, flushedOnMessageDone: streamState.flushedOnMessageDone });
        if (session.transcriptWatcher) {
          session.transcriptWatcher.stop();
          session.transcriptWatcher = null;
        }
        session.info.status = "idle";
        session.emitter.emit("status", sessionId, "idle");

        if (session.compacting) {
          logDiag(sessionId, "compact:done-on-pty-exit");
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
    });

    session.ptyRuntime = runtime;
    session.hasSpawnedBefore = true;

    this.cleanupAttachments(session);
    const attachments = this.writeAttachments(images, documents);
    session.attachmentPaths.push(...attachments);
    const ptyText = text ? this.buildPtyText(text, attachments) : text;

    const watcher = new TranscriptWatcher(session.cliSessionId, session.info.cwd, (messages, lastUsage) => {
      session.emitter.emit("transcript", sessionId, messages);
      if (lastUsage) {
        session.contextUsage = lastUsage;
        session.emitter.emit("usage", sessionId, lastUsage);
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
    });
    session.transcriptWatcher = watcher;

    this.startTodoWatcher(session, sessionId);

    runtime
      .start(ptyText)
      .then(() => {
        this.log(sessionId, `PTY claude ready (pid=${runtime.pid})`);
        watcher.start();
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(sessionId, `pty runtime start failed: ${msg}`);
        session.ptyRuntime = null;
        session.info.status = "idle";
        session.emitter.emit("status", sessionId, "idle");
        session.emitter.emit("error", sessionId, msg);
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
