import { spawn, type ChildProcess } from "node:child_process";
import { type Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";
import type { SessionInfo, ChatMessage, ToolUse, ContentBlock, ThinkingLevel, ContextUsage, TodoItem, ImageAttachment, DocumentAttachment, InitData } from "@/types";
import { EventParser, type ParsedEvent } from "./event-parser";
import { loadTranscript, transcriptExists } from "./transcript";
import { logRawLine } from "./debug-logger";
import { getSessionPrefs, setSessionPrefs } from "./session-prefs";
import { getDefaults } from "./defaults";

export interface SessionEvents {
  event: [sessionId: string, event: ParsedEvent];
  status: [sessionId: string, status: "idle" | "running"];
  error: [sessionId: string, error: string];
}

export interface PendingRequest {
  type: "permission" | "question";
  requestId: string;
  toolName: string;
  toolInput: string;
  rawToolInput?: Record<string, unknown>;
}

export interface StreamingSnapshot {
  messageId: string;
  content: string;
  toolUses: ToolUse[];
  blocks: ContentBlock[];
}

interface QueuedMessage {
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
  bypassAllPermissions: boolean;
  compacting: boolean;
  thinkingLevel: ThinkingLevel;
  contextUsage: ContextUsage | null;
  contextWindowSize: number;
  todoItems: TodoItem[];
  initData?: InitData;
  pendingRequests: Map<string, PendingRequest>;
  streamingSnapshot: StreamingSnapshot | null;
  queuedMessages: QueuedMessage[];
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private staleCheckInterval: ReturnType<typeof setInterval>;

  constructor() {
    // Periodically check for sessions stuck in "running" with a dead process
    this.staleCheckInterval = setInterval(() => {
      for (const [id, session] of this.sessions) {
        if (session.info.status === "running" && !session.process) {
          const short = id.slice(0, 8);
          console.log(`[session:${short}] stale check: status=running but process=null, correcting to idle`);
          session.info.status = "idle";
          session.emitter.emit("status", id, "idle");
        }
      }
    }, 15000);
  }

  createSession(cwd: string, name?: string): SessionInfo {
    const id = uuidv4();
    const now = Date.now();
    const defaults = getDefaults();
    const info: SessionInfo = {
      id,
      name: name || cwd.split("/").pop() || cwd,
      cwd,
      createdAt: now,
      lastActiveAt: now,
      status: "idle",
      model: defaults.model || undefined,
    };

    this.sessions.set(id, {
      info,
      process: null,
      stdin: null,
      emitter: new EventEmitter(),
      hasSpawnedBefore: false,
      bypassAllPermissions: defaults.bypassAllPermissions,
      compacting: false,
      thinkingLevel: defaults.thinkingLevel,
      contextUsage: null,
      contextWindowSize: 200_000,
      todoItems: [],
      pendingRequests: new Map(),
      streamingSnapshot: null,
      queuedMessages: [],
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
          name: prefs?.name || cwd.split("/").pop() || cwd,
          cwd,
          createdAt: now,
          lastActiveAt: now,
          status: "idle",
          model: prefs?.model || defaults.model || undefined,
        },
        process: null,
        stdin: null,
        emitter: new EventEmitter(),
        hasSpawnedBefore: true,
        bypassAllPermissions: prefs?.bypassAllPermissions ?? defaults.bypassAllPermissions,
        compacting: false,
        thinkingLevel: prefs?.thinkingLevel || defaults.thinkingLevel,
        contextUsage: null,
        contextWindowSize: 200_000,
        todoItems: [],
        pendingRequests: new Map(),
        streamingSnapshot: null,
        queuedMessages: [],
      };
      this.sessions.set(id, session);
    }
    return session;
  }

  async getSession(id: string): Promise<{ info: SessionInfo; messages: ChatMessage[] } | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    const messages = await loadTranscript(id, session.info.cwd);
    const defaultName = session.info.cwd.split("/").pop() || session.info.cwd;
    if (session.info.name === defaultName && messages.length > 0) {
      const firstUser = messages.find((m) => m.role === "user" && m.content && !m.content.startsWith("[") && !m.content.startsWith("<"));
      if (firstUser) {
        session.info.name = firstUser.content.slice(0, 120);
      }
    }
    return { info: session.info, messages };
  }

  async getSessionByCwd(id: string, cwd: string): Promise<{ info: SessionInfo; messages: ChatMessage[] } | null> {
    this.ensureSession(id, cwd);
    const messages = await loadTranscript(id, cwd);
    const session = this.sessions.get(id)!;
    // Derive title from first user message if name is still the default
    const defaultName = cwd.split("/").pop() || cwd;
    if (session.info.name === defaultName && messages.length > 0) {
      const firstUser = messages.find((m) => m.role === "user" && m.content && !m.content.startsWith("[") && !m.content.startsWith("<"));
      if (firstUser) {
        session.info.name = firstUser.content.slice(0, 120);
      }
    }
    return { info: session.info, messages };
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

  isProcessAlive(id: string): boolean {
    const session = this.sessions.get(id);
    return !!session?.process;
  }

  fixStaleStatus(id: string): void {
    const session = this.sessions.get(id);
    if (session && session.info.status === "running" && !session.process) {
      session.info.status = "idle";
      session.pendingRequests.clear();
    }
  }

  destroySession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.process) {
      this.killProcessGroup(session.process);
    }
    session.emitter.removeAllListeners();
    this.sessions.delete(id);
    return true;
  }

  subscribe(
    id: string,
    listener: (event: ParsedEvent) => void
  ): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;

    const handler = (_sessionId: string, event: ParsedEvent) => {
      listener(event);
    };

    session.emitter.on("event", handler);
    return () => session.emitter.off("event", handler);
  }

  onStatus(
    id: string,
    listener: (status: "idle" | "running") => void
  ): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;

    const handler = (_sessionId: string, status: "idle" | "running") => {
      listener(status);
    };

    session.emitter.on("status", handler);
    return () => session.emitter.off("status", handler);
  }

  onError(
    id: string,
    listener: (error: string) => void
  ): (() => void) | null {
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
    if (!session?.process) return false;

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
      session.stdin.write(JSON.stringify(request) + "\n");
      return true;
    }

    // Fallback: if stdin is gone for some reason, kill the process
    session.process.kill("SIGINT");
    return true;
  }

  addPendingRequest(sessionId: string, request: PendingRequest): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pendingRequests.set(request.requestId, request);
    }
  }

  removePendingRequest(sessionId: string, requestId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pendingRequests.delete(requestId);
    }
  }

  getPendingRequests(sessionId: string): PendingRequest[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return Array.from(session.pendingRequests.values());
  }

  respondToPermission(sessionId: string, requestId: string, allowed: boolean, toolInput?: Record<string, unknown>, permissionSuggestions?: Record<string, unknown>[]): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.stdin) return false;

    session.pendingRequests.delete(requestId);

    const response = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: allowed
          ? {
              behavior: "allow" as const,
              updatedInput: toolInput || {},
              ...(permissionSuggestions?.length ? { updatedPermissions: permissionSuggestions } : {}),
            }
          : { behavior: "deny" as const, message: "User denied" },
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
    this.sendPermissionMode(session, sessionId, "bypassPermissions");
    this.emitSystem(session, sessionId, "__bypass_state::on");
  }

  clearBypassAllPermissions(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.bypassAllPermissions) return;
    session.bypassAllPermissions = false;
    setSessionPrefs(sessionId, { bypassAllPermissions: false });
    this.sendPermissionMode(session, sessionId, "default");
    this.emitSystem(session, sessionId, "__bypass_state::off");
  }

  isBypassActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.bypassAllPermissions ?? false;
  }

  setModel(sessionId: string, model: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.info.model === model) return;
    session.info.model = model;
    setSessionPrefs(sessionId, { model });

    if (session.stdin) {
      const request = {
        type: "control_request",
        request_id: `model-${Date.now()}`,
        request: { subtype: "set_model", model },
      };
      session.stdin.write(JSON.stringify(request) + "\n");
    } else {
      this.killProcess(session);
      session.queuedMessages.length = 0;
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

    if (session.stdin) {
      const request = {
        type: "control_request",
        request_id: `effort-${Date.now()}`,
        request: { subtype: "apply_flag_settings", settings: { effort: level } },
      };
      session.stdin.write(JSON.stringify(request) + "\n");
    } else {
      this.killProcess(session);
      session.queuedMessages.length = 0;
      session.info.status = "idle";
      session.emitter.emit("status", sessionId, "idle");
    }
    this.emitSystem(session, sessionId, `__thinking_level::${level}`);
  }

  getThinkingLevel(sessionId: string): ThinkingLevel {
    return this.sessions.get(sessionId)?.thinkingLevel ?? "high";
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

  onQueued(
    id: string,
    listener: (count: number, sentText?: string) => void
  ): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const handler = (_sessionId: string, count: number, sentText?: string) => listener(count, sentText);
    session.emitter.on("queued", handler);
    return () => session.emitter.off("queued", handler);
  }

  private flushQueuedMessage(session: Session, sessionId: string): void {
    if (session.queuedMessages.length === 0) return;
    const next = session.queuedMessages.shift()!;
    session.emitter.emit("queued", sessionId, session.queuedMessages.length, next.text);
    this.sendMessage(sessionId, next.text, next.images, next.documents);
  }

  onUsage(
    id: string,
    listener: (usage: ContextUsage) => void
  ): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const handler = (_sessionId: string, usage: ContextUsage) => listener(usage);
    session.emitter.on("usage", handler);
    return () => session.emitter.off("usage", handler);
  }

  getTodos(sessionId: string): TodoItem[] {
    return this.sessions.get(sessionId)?.todoItems ?? [];
  }

  onTodos(
    id: string,
    listener: (todos: TodoItem[]) => void
  ): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const handler = (_sessionId: string, todos: TodoItem[]) => listener(todos);
    session.emitter.on("todos", handler);
    return () => session.emitter.off("todos", handler);
  }

  getInitData(sessionId: string): InitData | undefined {
    return this.sessions.get(sessionId)?.initData;
  }

  setInitData(sessionId: string, data: InitData): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.initData = data;
    session.emitter.emit("init", sessionId, data);
  }

  onInit(
    id: string,
    listener: (data: InitData) => void
  ): (() => void) | null {
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
      session.todoItems = todos.filter((t: Record<string, unknown>) => t.content && t.status).map((t: Record<string, unknown>) => ({
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

    // Find the last TodoWrite call in history, but stop at compact boundaries
    // (which mark /clear points) to avoid resurrecting pre-clear todos.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "system" && msg.content === "__compacted__") break;
      if (msg.role !== "assistant") continue;
      for (let j = msg.toolUses.length - 1; j >= 0; j--) {
        if (msg.toolUses[j].name === "TodoWrite") {
          this.handleTodoWrite(session, sessionId, msg.toolUses[j].input);
          return;
        }
      }
    }
  }

  private extractUsage(session: Session, sessionId: string, line: string): void {
    try {
      const raw = JSON.parse(line.trim());

      if (raw.type === "result" && raw.modelUsage) {
        this.extractContextWindowSize(session, raw.modelUsage);
      }

      if (raw.type !== "assistant" || !raw.message?.usage) return;
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
    if (proc.pid) {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        // Process group already dead
      }
    }
  }

  private killProcess(session: Session): void {
    if (session.process) {
      session.process.on("close", () => {});
      this.killProcessGroup(session.process);
      session.process = null;
      session.stdin = null;
    }
    session.compacting = false;
  }

  private emitSystem(session: Session, sessionId: string, text: string): void {
    session.emitter.emit("system", sessionId, text);
  }

  private emitInfoUpdated(session: Session, sessionId: string): void {
    session.emitter.emit("info_updated", sessionId, { ...session.info });
  }

  onSystem(
    id: string,
    listener: (text: string) => void
  ): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const handler = (_sessionId: string, text: string) => listener(text);
    session.emitter.on("system", handler);
    return () => session.emitter.off("system", handler);
  }

  onClear(
    id: string,
    listener: () => void
  ): (() => void) | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const handler = () => listener();
    session.emitter.on("clear", handler);
    return () => session.emitter.off("clear", handler);
  }

  onInfoUpdated(
    id: string,
    listener: (info: SessionInfo) => void
  ): (() => void) | null {
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
        session.hasSpawnedBefore = false;
        session.queuedMessages.length = 0;
        session.todoItems = [];
        session.info.status = "idle";
        session.emitter.emit("clear", sessionId);
        session.emitter.emit("status", sessionId, "idle");
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

  private buildContent(text: string, images?: ImageAttachment[], documents?: DocumentAttachment[]): string | Record<string, unknown>[] {
    if (!images?.length && !documents?.length) return text;
    return [
      ...images?.map((img) => ({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data },
      })) || [],
      ...documents?.map((doc) => ({
        type: "document",
        source: { type: "base64", media_type: doc.mediaType, data: doc.data },
      })) || [],
      ...(text ? [{ type: "text", text }] : []),
    ];
  }

  sendMessage(sessionId: string, text: string, images?: ImageAttachment[], documents?: DocumentAttachment[]): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (text.startsWith("/")) {
      const handled = this.handleCommand(sessionId, text);
      if (handled) return true;

      if (text.trim().toLowerCase().startsWith("/compact")) {
        session.compacting = true;
        this.emitSystem(session, sessionId, "__compact::start");
      }
    }

    const content = this.buildContent(text, images, documents);

    // If already running, queue the message to send when the session goes idle
    if (session.info.status === "running") {
      session.queuedMessages.push({ text, images, documents });
      session.emitter.emit("queued", sessionId, session.queuedMessages.length);
      return true;
    }

    session.info.status = "running";
    session.emitter.emit("status", sessionId, "running");

    if (session.process && session.stdin) {
      const userInput = { type: "user", message: { role: "user", content } };
      session.stdin.write(JSON.stringify(userInput) + "\n");
      return true;
    }

    this.spawnProcess(session, sessionId, text, images, documents);
    return true;
  }

  private log(sessionId: string, msg: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    const short = sessionId.slice(0, 8);
    console.log(`[session:${short}] ${ts} ${msg}`);
  }

  private spawnProcess(session: Session, sessionId: string, text: string, images?: ImageAttachment[], documents?: DocumentAttachment[]): void {
    this.log(sessionId, `spawning CLI process (resume=${session.hasSpawnedBefore}, model=${session.info.model || "sonnet"})`);
    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
    ];

    // Always enable bypass as an option so it can be toggled mid-session
    // via set_permission_mode control request. Permission prompts still go
    // through stdio so the UI can surface them when bypass is off.
    args.push("--allow-dangerously-skip-permissions");
    args.push("--permission-prompt-tool", "stdio");

    if (session.bypassAllPermissions) {
      args.push("--permission-mode", "bypassPermissions");
    }

    if (session.hasSpawnedBefore || transcriptExists(sessionId, session.info.cwd)) {
      args.push("--resume", session.info.id);
    } else {
      args.push("--session-id", session.info.id);
    }

    if (session.info.model) {
      args.push("--model", session.info.model);
    }

    args.push("--effort", session.thinkingLevel);

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const proc = spawn("claude", args, {
      cwd: session.info.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    session.process = proc;
    session.stdin = proc.stdin!;
    session.hasSpawnedBefore = true;
    this.log(sessionId, `CLI process spawned (pid=${proc.pid})`);

    const content = this.buildContent(text, images, documents);
    const userInput = { type: "user", message: { role: "user", content } };
    proc.stdin!.write(JSON.stringify(userInput) + "\n");

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
    const pendingToolUses: ToolUse[] = [];
    const pendingBlocks: ContentBlock[] = [];
    const agentStack: ToolUse[] = [];
    let currentAssistantMsgId: string | null = null;
    let flushedOnMessageDone = false;

    const updateSnapshot = () => {
      if (currentAssistantMsgId && pendingBlocks.length > 0) {
        const textContent = pendingBlocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        session.streamingSnapshot = {
          messageId: currentAssistantMsgId,
          content: textContent,
          toolUses: pendingToolUses.map((t) => ({ ...t, children: t.children ? [...t.children] : undefined })),
          blocks: pendingBlocks.map((b) => b.type === "tool_use" ? { ...b, toolUse: { ...b.toolUse } } : { ...b }),
        };
      } else {
        session.streamingSnapshot = null;
      }
    };

    let lineBuffer = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";

      // If the remaining buffer looks like a complete JSON object,
      // process it immediately to avoid deadlocks when the CLI
      // blocks waiting for a control_response after writing the last line.
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
        // Only extract usage from main thread messages, not sub-agents.
        // Sub-agent usage causes the context indicator to flicker.
        if (agentStack.length === 0) {
          this.extractUsage(session, sessionId, line);
        }
        const events = parser.parseLine(line);
        for (const event of events) {
          // Finalize the previous assistant message when a new one starts.
          // When an Agent tool is active, sub-agent messages arrive with
          // different assistantMessageIds. Don't finalize the parent message
          // in that case - keep accumulating under the Agent.
          if (event.assistantMessageId && event.assistantMessageId !== currentAssistantMsgId) {
            if (agentStack.length === 0) {
              if (currentAssistantMsgId && pendingBlocks.length > 0) {
                const textContent = pendingBlocks
                  .filter((b) => b.type === "text")
                  .map((b) => b.text)
                  .join("");
                const intermediateMsg: ChatMessage = {
                  id: currentAssistantMsgId,
                  role: "assistant",
                  content: textContent,
                  toolUses: [...pendingToolUses],
                  blocks: [...pendingBlocks],
                  timestamp: Date.now(),
                };
                session.emitter.emit("event", sessionId, { type: "message_done", message: intermediateMsg } as ParsedEvent);
                if (intermediateMsg.toolUses.some((t: ToolUse) => t.name === "Agent")) {
                  this.loadAgentChildren(session, sessionId, intermediateMsg.id, session.info.cwd);
                }
                pendingToolUses.length = 0;
                pendingBlocks.length = 0;
              }
              currentAssistantMsgId = event.assistantMessageId;
            }
          }

          if (event.type === "thinking" && event.text) {
            // Sub-agent thinking is not useful to the client; the Agent
            // tool's output is already streamed via tool_progress events.
            if (agentStack.length > 0) continue;
            const last = pendingBlocks[pendingBlocks.length - 1];
            if (last && last.type === "thinking") {
              last.text += event.text;
            } else {
              pendingBlocks.push({ type: "thinking", text: event.text });
            }
          } else if (event.type === "text_delta" && event.text) {
            if (agentStack.length > 0) continue;
            const last = pendingBlocks[pendingBlocks.length - 1];
            if (last && last.type === "text") {
              last.text += event.text;
            } else {
              pendingBlocks.push({ type: "text", text: event.text });
            }
          } else if (event.type === "tool_use_start") {
            const tool: ToolUse = {
              id: event.toolId || "",
              name: event.toolName || "",
              input: event.toolInput || "",
              output: "",
              status: "running",
            };

            const isAgent = tool.name === "Agent";

            if (tool.name === "TodoWrite") {
              this.handleTodoWrite(session, sessionId, tool.input);
            }

            // Tools from the main thread (same assistantMessageId) are
            // top-level, even when agents are running in parallel.
            // Only tools from sub-agents (different assistantMessageId)
            // are children of an agent.
            const isFromMainThread = event.assistantMessageId === currentAssistantMsgId;
            event.isMainThread = isFromMainThread;

            if (agentStack.length > 0 && !isFromMainThread) {
              const parent = agentStack[agentStack.length - 1];
              if (!parent.children) parent.children = [];
              parent.children.push(tool);
            } else {
              pendingToolUses.push(tool);
              pendingBlocks.push({ type: "tool_use", toolUse: tool });
            }

            if (isAgent) {
              agentStack.push(tool);
            }
          } else if (event.type === "tool_result") {
            // Find the agent anywhere in the stack, not just the top.
            // Parallel agents complete in arbitrary order.
            const agentIdx = agentStack.findIndex((a) => a.id === event.toolId);
            if (agentIdx !== -1) {
              agentStack[agentIdx].output = event.toolOutput || "";
              if (event.filePath) agentStack[agentIdx].filePath = event.filePath;
              agentStack[agentIdx].status = "done";
              agentStack.splice(agentIdx, 1);
            } else if (agentStack.length > 0) {
              // Search all agents' children, not just the top agent
              for (const agent of agentStack) {
                const child = agent.children?.find((t) => t.id === event.toolId);
                if (child) {
                  child.output = event.toolOutput || "";
                  if (event.filePath) child.filePath = event.filePath;
                  child.status = "done";
                  break;
                }
              }
            } else {
              const tool = pendingToolUses.find((t) => t.id === event.toolId);
              if (tool) {
                tool.output = event.toolOutput || "";
                if (event.filePath) tool.filePath = event.filePath;
                tool.status = "done";
              }
            }
          } else if (event.type === "tool_progress" && event.toolId && event.text) {
            // Search all agents and their children for progress updates
            const agent = agentStack.find((a) => a.id === event.toolId);
            if (agent) {
              agent.output += event.text;
            } else if (agentStack.length > 0) {
              let found = false;
              for (const a of agentStack) {
                const child = a.children?.find((t) => t.id === event.toolId);
                if (child) {
                  child.output += event.text;
                  found = true;
                  break;
                }
              }
              if (!found) {
                const tool = pendingToolUses.find((t) => t.id === event.toolId);
                if (tool) tool.output += event.text;
              }
            } else {
              const tool = pendingToolUses.find((t) => t.id === event.toolId);
              if (tool) tool.output += event.text;
            }
          } else if (event.type === "system_message" && event.text) {
            this.emitSystem(session, sessionId, event.text);
          } else if (event.type === "message_done" && event.message) {
            // Interrupted turn (control_request interrupt): discard partial
            // content and go idle without emitting a message.
            if (event.interrupted) {
              pendingBlocks.length = 0;
              pendingToolUses.length = 0;
              agentStack.length = 0;
              currentAssistantMsgId = null;
              session.streamingSnapshot = null;
              session.info.status = "idle";
              session.emitter.emit("status", sessionId, "idle");
              flushedOnMessageDone = true;
              this.flushQueuedMessage(session, sessionId);
              continue;
            }

            // If all messages were already finalized via intermediate emissions,
            // skip the duplicate result message but still update status.
            if (pendingBlocks.length === 0 && pendingToolUses.length === 0 && currentAssistantMsgId) {
              currentAssistantMsgId = null;
              session.info.status = "idle";
              session.emitter.emit("status", sessionId, "idle");
              if (session.compacting) {
                session.compacting = false;
                this.emitSystem(session, sessionId, "__compact::done");
              }
              flushedOnMessageDone = true;
              this.flushQueuedMessage(session, sessionId);
              continue;
            }

            if (currentAssistantMsgId) {
              event.message.id = currentAssistantMsgId;
            }
            const hasStreamedText = pendingBlocks.some((b) => b.type === "text");
            if (event.message.content && !hasStreamedText) {
              pendingBlocks.push({ type: "text", text: event.message.content });
            }

            // Filter out noise messages that shouldn't appear as chat bubbles
            if (pendingToolUses.length === 0) {
              const fullText = pendingBlocks
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("")
                .trim();

              // "No response requested." is emitted by the CLI after SIGINT
              // (fallback path if stdin is unavailable).
              if (fullText === "No response requested.") {
                pendingBlocks.length = 0;
                currentAssistantMsgId = null;
                session.info.status = "idle";
                session.emitter.emit("status", sessionId, "idle");
                flushedOnMessageDone = true;
                this.flushQueuedMessage(session, sessionId);
                continue;
              }

              // Detect API errors (e.g. "API Error: 500 {"type":"error",...}")
              // and route them through the error path instead of chat.
              const apiErrMatch = fullText.match(/^API Error: (\d+)\s/);
              if (apiErrMatch) {
                const msgMatch = fullText.match(/"message"\s*:\s*"([^"]+)"/);
                const errMsg = msgMatch
                  ? `${msgMatch[1]} (HTTP ${apiErrMatch[1]})`
                  : fullText.slice(0, 200);
                pendingBlocks.length = 0;
                pendingToolUses.length = 0;
                agentStack.length = 0;
                currentAssistantMsgId = null;
                session.info.status = "idle";
                session.emitter.emit("status", sessionId, "idle");
                session.emitter.emit("error", sessionId, errMsg);
                flushedOnMessageDone = true;
                this.flushQueuedMessage(session, sessionId);
                continue;
              }
            }

            event.message.blocks = [...pendingBlocks];
            if (event.message.toolUses.length === 0 && pendingToolUses.length > 0) {
              event.message.toolUses = [...pendingToolUses];
            }
            pendingToolUses.length = 0;
            pendingBlocks.length = 0;
            agentStack.length = 0;
            currentAssistantMsgId = null;

            session.info.status = "idle";
            session.emitter.emit("status", sessionId, "idle");

            if (session.compacting) {
              session.compacting = false;
              this.emitSystem(session, sessionId, "__compact::done");
            }
            flushedOnMessageDone = true;
            this.flushQueuedMessage(session, sessionId);
          }
          // Store permission requests so they survive WS reconnections.
          // The CLI handles bypass/auto-allow natively via set_permission_mode,
          // so we only see requests that genuinely need user input.
          if (event.type === "permission_request" && event.requestId) {
            const toolName = event.toolName || "";
            session.pendingRequests.set(event.requestId, {
              type: toolName === "AskUserQuestion" ? "question" : "permission",
              requestId: event.requestId,
              toolName,
              toolInput: event.toolInput || "",
              rawToolInput: event.rawToolInput,
            });
          }

          session.emitter.emit("event", sessionId, event);
          updateSnapshot();

          if (event.type === "message_done" && event.message) {
            const hasAgent = event.message.toolUses.some((t: ToolUse) => t.name === "Agent");
            if (hasAgent) {
              this.loadAgentChildren(session, sessionId, event.message.id, session.info.cwd);
            }
          }
        }
      }
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    proc.on("close", (code, signal) => {
      this.log(sessionId, `CLI process exited (code=${code}, signal=${signal}, pid=${proc.pid})`);
      if (lineBuffer.trim()) {
        const events = parser.parseLine(lineBuffer);
        for (const event of events) {
          if (event.type === "message_done" && event.message) {
            const hasStreamedText = pendingBlocks.some((b) => b.type === "text");
            if (event.message.content && !hasStreamedText) {
              pendingBlocks.push({ type: "text", text: event.message.content });
            }
            event.message.blocks = [...pendingBlocks];
            if (event.message.toolUses.length === 0 && pendingToolUses.length > 0) {
              event.message.toolUses = [...pendingToolUses];
            }
            pendingToolUses.length = 0;
            pendingBlocks.length = 0;
          }
          session.emitter.emit("event", sessionId, event);
        }
      }

      session.process = null;
      session.stdin = null;
      session.streamingSnapshot = null;
      session.info.status = "idle";
      session.emitter.emit("status", sessionId, "idle");

      if (session.compacting) {
        session.compacting = false;
        this.emitSystem(session, sessionId, "__compact::done");
      }

      // Auto-clear todos when the turn ends and all items are completed
      if (session.todoItems.length > 0 && session.todoItems.every((t) => t.status === "completed")) {
        session.todoItems = [];
        session.emitter.emit("todos", sessionId, []);
      }

      if (code !== 0 && stderrBuffer.trim()) {
        session.emitter.emit("error", sessionId, stderrBuffer.trim());
      }

      // Only flush if message_done didn't already handle it.
      // message_done flushes and sends the queued message to the still-alive
      // process via stdin. If we flush again here, we'd send a second message
      // before the first one gets a response.
      if (!flushedOnMessageDone) {
        this.flushQueuedMessage(session, sessionId);
      }
    });

    proc.on("error", (err) => {
      this.log(sessionId, `CLI process error: ${err.message}`);
      session.process = null;
      session.stdin = null;
      session.info.status = "idle";
      session.emitter.emit("status", sessionId, "idle");
      session.emitter.emit("error", sessionId, err.message);
    });
  }

  private async loadAgentChildren(session: Session, sessionId: string, messageId: string, cwd: string): Promise<void> {
    try {
      const messages = await loadTranscript(sessionId, cwd);
      const msg = messages.find((m) => m.id === messageId);
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
