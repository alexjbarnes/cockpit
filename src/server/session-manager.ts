import { spawn, type ChildProcess } from "node:child_process";
import { type Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";
import type { SessionInfo, ChatMessage, ToolUse, ContentBlock } from "@/types";
import { EventParser, type ParsedEvent } from "./event-parser";
import { loadTranscript, transcriptExists } from "./transcript";

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
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  createSession(cwd: string, name?: string): SessionInfo {
    const id = uuidv4();
    const now = Date.now();
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
    });

    return info;
  }

  ensureSession(id: string, cwd: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      const now = Date.now();
      session = {
        info: {
          id,
          name: cwd.split("/").pop() || cwd,
          cwd,
          createdAt: now,
          lastActiveAt: now,
          status: "idle",
        },
        process: null,
        stdin: null,
        emitter: new EventEmitter(),
        hasSpawnedBefore: true,
      };
      this.sessions.set(id, session);
    }
    return session;
  }

  async getSession(id: string): Promise<{ info: SessionInfo; messages: ChatMessage[] } | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    const messages = await loadTranscript(id, session.info.cwd);
    return { info: session.info, messages };
  }

  async getSessionByCwd(id: string, cwd: string): Promise<{ info: SessionInfo; messages: ChatMessage[] } | null> {
    this.ensureSession(id, cwd);
    const messages = await loadTranscript(id, cwd);
    const session = this.sessions.get(id)!;
    return { info: session.info, messages };
  }

  listActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.process !== null)
      .map((s) => s.info);
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

  private killProcess(session: Session): void {
    if (session.process) {
      session.process.on("close", () => {});
      session.process.kill("SIGINT");
      session.process = null;
      session.stdin = null;
    }
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

  sendMessage(sessionId: string, text: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (text.startsWith("/")) {
      const handled = this.handleCommand(sessionId, text);
      if (handled) return true;
    }

    if (session.info.status === "running") {
      session.emitter.emit("error", sessionId, "A message is already being processed");
      return false;
    }

    session.info.status = "running";
    session.emitter.emit("status", sessionId, "running");

    if (session.process && session.stdin) {
      const userInput = { type: "user", message: { role: "user", content: text } };
      session.stdin.write(JSON.stringify(userInput) + "\n");
      return true;
    }

    this.spawnProcess(session, sessionId, text);
    return true;
  }

  private spawnProcess(session: Session, sessionId: string, text: string): void {
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

    const userInput = { type: "user", message: { role: "user", content: text } };
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

      for (const line of lines) {
        const events = parser.parseLine(line);
        for (const event of events) {
          if (event.type === "text_delta" && event.text) {
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
          }
          session.emitter.emit("event", sessionId, event);
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
}
