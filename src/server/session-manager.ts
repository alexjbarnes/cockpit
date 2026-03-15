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

interface Session {
  info: SessionInfo;
  process: ChildProcess | null;
  stdin: Writable | null;
  emitter: EventEmitter;
  hasSpawnedBefore: boolean;
  allowedTools: Set<string>;
  bypassAllPermissions: boolean;
  compacting: boolean;
  thinkingLevel: ThinkingLevel;
  contextUsage: ContextUsage | null;
  todoItems: TodoItem[];
  initData?: InitData;
}

export class SessionManager {
  private sessions = new Map<string, Session>();

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
    };

    this.sessions.set(id, {
      info,
      process: null,
      stdin: null,
      emitter: new EventEmitter(),
      hasSpawnedBefore: false,
      allowedTools: new Set(),
      bypassAllPermissions: defaults.bypassAllPermissions,
      compacting: false,
      thinkingLevel: defaults.thinkingLevel,
      contextUsage: null,
      todoItems: [],
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
        },
        process: null,
        stdin: null,
        emitter: new EventEmitter(),
        hasSpawnedBefore: true,
        allowedTools: new Set(prefs?.allowedTools || []),
        bypassAllPermissions: prefs?.bypassAllPermissions ?? defaults.bypassAllPermissions,
        compacting: false,
        thinkingLevel: prefs?.thinkingLevel || defaults.thinkingLevel,
        contextUsage: null,
        todoItems: [],
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

  listActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.process !== null)
      .map((s) => s.info);
  }

  listKnownSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.info);
  }

  destroySession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.process) {
      session.process.kill("SIGINT");
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
    session.process.kill("SIGINT");
    return true;
  }

  respondToPermission(sessionId: string, requestId: string, allowed: boolean, toolInput?: Record<string, unknown>): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.stdin) return false;

    const response = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: allowed
          ? { behavior: "allow" as const, updatedInput: toolInput || {} }
          : { behavior: "deny" as const, message: "User denied" },
      },
    };

    session.stdin.write(JSON.stringify(response) + "\n");
    return true;
  }

  allowToolAlways(sessionId: string, toolName: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.allowedTools.add(toolName);
      setSessionPrefs(sessionId, { allowedTools: Array.from(session.allowedTools) });
    }
  }

  setBypassAllPermissions(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.bypassAllPermissions) return;
    session.bypassAllPermissions = true;
    setSessionPrefs(sessionId, { bypassAllPermissions: true });
    this.emitSystem(session, sessionId, "__bypass_state::on");
  }

  clearBypassAllPermissions(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.bypassAllPermissions) return;
    session.bypassAllPermissions = false;
    setSessionPrefs(sessionId, { bypassAllPermissions: false });
    this.emitSystem(session, sessionId, "__bypass_state::off");
  }

  isBypassActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.bypassAllPermissions ?? false;
  }

  shouldAutoAllow(sessionId: string, toolName: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.bypassAllPermissions || session.allowedTools.has(toolName);
  }

  setThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.thinkingLevel === level) return;
    session.thinkingLevel = level;
    setSessionPrefs(sessionId, { thinkingLevel: level });
    // Kill current process so next message spawns with new env var
    this.killProcess(session);
    session.info.status = "idle";
    session.emitter.emit("status", sessionId, "idle");
    this.emitSystem(session, sessionId, `__thinking_level::${level}`);
  }

  getThinkingLevel(sessionId: string): ThinkingLevel {
    return this.sessions.get(sessionId)?.thinkingLevel ?? "high";
  }

  getContextUsage(sessionId: string): ContextUsage | null {
    return this.sessions.get(sessionId)?.contextUsage ?? null;
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

    // Find the last TodoWrite call in history to get current state
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
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
      if (raw.type !== "assistant" || !raw.message?.usage) return;
      const u = raw.message.usage;
      const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      const usage: ContextUsage = { used, total: 200_000 };
      session.contextUsage = usage;
      session.emitter.emit("usage", sessionId, usage);
    } catch {
      // not valid JSON, ignore
    }
  }

  private killProcess(session: Session): void {
    if (session.process) {
      session.process.on("close", () => {});
      session.process.kill("SIGINT");
      session.process = null;
      session.stdin = null;
    }
    session.allowedTools.clear();
    session.bypassAllPermissions = false;
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
          "Aperture commands:",
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

    // "btw" nudge: if already running and process has stdin, inject the message mid-stream
    if (session.info.status === "running") {
      if (session.process && session.stdin) {
        const userInput = { type: "user", message: { role: "user", content } };
        session.stdin.write(JSON.stringify(userInput) + "\n");
        return true;
      }
      session.emitter.emit("error", sessionId, "A message is already being processed");
      return false;
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

  private spawnProcess(session: Session, sessionId: string, text: string, images?: ImageAttachment[], documents?: DocumentAttachment[]): void {
    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio",
    ];

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
    });

    session.process = proc;
    session.stdin = proc.stdin!;
    session.hasSpawnedBefore = true;

    const content = this.buildContent(text, images, documents);
    const userInput = { type: "user", message: { role: "user", content } };
    proc.stdin!.write(JSON.stringify(userInput) + "\n");

    const parser = new EventParser();
    let stderrBuffer = "";
    const pendingToolUses: ToolUse[] = [];
    const pendingBlocks: ContentBlock[] = [];
    const agentStack: ToolUse[] = [];

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
        this.extractUsage(session, sessionId, line);
        const events = parser.parseLine(line);
        for (const event of events) {
          if (event.type === "thinking" && event.text) {
            const last = pendingBlocks[pendingBlocks.length - 1];
            if (last && last.type === "thinking") {
              last.text += event.text;
            } else {
              pendingBlocks.push({ type: "thinking", text: event.text });
            }
          } else if (event.type === "text_delta" && event.text) {
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

            if (agentStack.length > 0) {
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
            const topAgent = agentStack[agentStack.length - 1];
            if (topAgent && topAgent.id === event.toolId) {
              topAgent.output = event.toolOutput || "";
              if (event.filePath) topAgent.filePath = event.filePath;
              topAgent.status = "done";
              agentStack.pop();
            } else if (agentStack.length > 0) {
              const parent = agentStack[agentStack.length - 1];
              const child = parent.children?.find((t) => t.id === event.toolId);
              if (child) {
                child.output = event.toolOutput || "";
                if (event.filePath) child.filePath = event.filePath;
                child.status = "done";
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
            const topAgent = agentStack[agentStack.length - 1];
            if (topAgent && topAgent.id === event.toolId) {
              topAgent.output += event.text;
            } else if (agentStack.length > 0) {
              const parent = agentStack[agentStack.length - 1];
              const child = parent.children?.find((t) => t.id === event.toolId);
              if (child) child.output += event.text;
            } else {
              const tool = pendingToolUses.find((t) => t.id === event.toolId);
              if (tool) tool.output += event.text;
            }
          } else if (event.type === "system_message" && event.text) {
            this.emitSystem(session, sessionId, event.text);
          } else if (event.type === "message_done" && event.message) {
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
            agentStack.length = 0;

            session.info.status = "idle";
            session.emitter.emit("status", sessionId, "idle");

            if (session.compacting) {
              session.compacting = false;
              this.emitSystem(session, sessionId, "__compact::done");
            }
          }
          session.emitter.emit("event", sessionId, event);

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

    proc.on("close", (code) => {
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
      session.info.status = "idle";
      session.emitter.emit("status", sessionId, "idle");

      if (session.compacting) {
        session.compacting = false;
        this.emitSystem(session, sessionId, "__compact::done");
      }

      if (code !== 0 && stderrBuffer.trim()) {
        session.emitter.emit("error", sessionId, stderrBuffer.trim());
      }
    });

    proc.on("error", (err) => {
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
