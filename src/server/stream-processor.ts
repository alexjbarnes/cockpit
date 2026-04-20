import type { ChatMessage, ContentBlock, ToolUse } from "@/types";
import type { ParsedEvent } from "./event-parser";

export interface StreamState {
  pendingToolUses: ToolUse[];
  pendingBlocks: ContentBlock[];
  agentStack: ToolUse[];
  currentAssistantMsgId: string | null;
  flushedOnMessageDone: boolean;
  thinkingStartedAt: number | null;
}

export interface ProcessedResult {
  emit: ParsedEvent[];
  systemMessages: string[];
  errors: string[];
  intermediateMessages: ChatMessage[];
  statusChange?: "idle";
  snapshot: {
    messageId: string;
    content: string;
    toolUses: ToolUse[];
    blocks: ContentBlock[];
  } | null;
  permissionActions: PermissionAction[];
  todoInputs: string[];
  compactDone: boolean;
}

export interface PermissionAction {
  type: "auto_approve" | "auto_deny" | "store";
  requestId: string;
  toolName: string;
  toolInput?: string;
  rawToolInput?: Record<string, unknown>;
  denyReason?: string;
  permissionSuggestions?: Record<string, unknown>[];
}

const READ_ONLY_BASH_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "find",
  "pwd",
  "which",
  "type",
  "whereis",
  "file",
  "stat",
  "du",
  "df",
  "tree",
  "date",
  "echo",
  "printf",
  "env",
  "printenv",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "uname",
  "whoami",
  "hostname",
  "id",
  "dir",
  "findstr",
  "where",
  "more",
  "sort",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "branch",
  "remote",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "describe",
  "tag",
  "reflog",
]);

const WRITE_TOOLS = new Set(["Edit", "Write", "Bash", "NotebookEdit"]);
const USER_FACING_TOOLS = new Set(["ExitPlanMode", "AskUserQuestion", "EnterPlanMode"]);

export function isReadOnlyBashCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  if (/(?:;|&&|\|\||>|<|`|\$\(|<\()/.test(trimmed)) return false;
  if (/(?:^|[^|])&(?!&)/.test(trimmed)) return false;
  const segments = trimmed
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) return false;
  for (const segment of segments) {
    const [head, sub] = segment.split(/\s+/);
    if (head === "git") {
      if (!sub || !READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return false;
      continue;
    }
    if (!READ_ONLY_BASH_COMMANDS.has(head)) return false;
  }
  return true;
}

export function createStreamState(): StreamState {
  return {
    pendingToolUses: [],
    pendingBlocks: [],
    agentStack: [],
    currentAssistantMsgId: null,
    flushedOnMessageDone: false,
    thinkingStartedAt: null,
  };
}

function buildSnapshot(state: StreamState): ProcessedResult["snapshot"] {
  if (state.currentAssistantMsgId && state.pendingBlocks.length > 0) {
    const textContent = state.pendingBlocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      messageId: state.currentAssistantMsgId,
      content: textContent,
      toolUses: state.pendingToolUses.map((t) => ({ ...t, children: t.children ? [...t.children] : undefined })),
      blocks: state.pendingBlocks.map((b) => (b.type === "tool_use" ? { ...b, toolUse: { ...b.toolUse } } : { ...b })),
    };
  }
  return null;
}

export function processEvents(
  events: ParsedEvent[],
  state: StreamState,
  options: { planMode: boolean; compacting: boolean },
): ProcessedResult {
  const result: ProcessedResult = {
    emit: [],
    systemMessages: [],
    errors: [],
    intermediateMessages: [],
    snapshot: null,
    permissionActions: [],
    todoInputs: [],
    compactDone: false,
  };

  for (const event of events) {
    if (event.assistantMessageId && event.assistantMessageId !== state.currentAssistantMsgId) {
      if (state.agentStack.length === 0) {
        if (state.currentAssistantMsgId && state.pendingBlocks.length > 0) {
          const textContent = state.pendingBlocks
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
          const intermediateMsg: ChatMessage = {
            id: state.currentAssistantMsgId,
            role: "assistant",
            content: textContent,
            toolUses: [...state.pendingToolUses],
            blocks: [...state.pendingBlocks],
            timestamp: Date.now(),
          };
          result.intermediateMessages.push(intermediateMsg);
          state.pendingToolUses.length = 0;
          state.pendingBlocks.length = 0;
        }
        state.currentAssistantMsgId = event.assistantMessageId;
      }
    }

    if (event.type === "thinking" && (event.text || event.redacted)) {
      if (state.agentStack.length > 0) continue;
      const last = state.pendingBlocks[state.pendingBlocks.length - 1];
      if (last && last.type === "thinking") {
        last.text += event.text ?? "";
        if (event.redacted) last.redacted = true;
      } else {
        state.pendingBlocks.push({ type: "thinking", text: event.text ?? "", redacted: event.redacted });
      }
    } else if (event.type === "text_delta" && event.text) {
      if (state.agentStack.length > 0) continue;
      if (state.thinkingStartedAt !== null && state.pendingBlocks.some((b) => b.type === "thinking")) {
        const durationMs = Date.now() - state.thinkingStartedAt;
        state.thinkingStartedAt = null;
        for (const block of state.pendingBlocks) {
          if (block.type === "thinking") block.durationMs = durationMs;
        }
        result.emit.push({ type: "thinking", durationMs });
      } else {
        state.thinkingStartedAt = null;
      }
      const last = state.pendingBlocks[state.pendingBlocks.length - 1];
      if (last && last.type === "text") {
        last.text += event.text;
      } else {
        state.pendingBlocks.push({ type: "text", text: event.text });
      }
    } else if (event.type === "tool_use_start") {
      if (state.thinkingStartedAt !== null && state.pendingBlocks.some((b) => b.type === "thinking")) {
        const durationMs = Date.now() - state.thinkingStartedAt;
        state.thinkingStartedAt = null;
        for (const block of state.pendingBlocks) {
          if (block.type === "thinking") block.durationMs = durationMs;
        }
        result.emit.push({ type: "thinking", durationMs });
      } else {
        state.thinkingStartedAt = null;
      }
      const tool: ToolUse = {
        id: event.toolId || "",
        name: event.toolName || "",
        input: event.toolInput || "",
        output: "",
        status: "running",
      };

      const isAgent = tool.name === "Agent";

      if (tool.name === "TodoWrite") {
        result.todoInputs.push(tool.input);
      }

      const isFromMainThread = event.assistantMessageId === state.currentAssistantMsgId;
      event.isMainThread = isFromMainThread;

      if (state.agentStack.length > 0 && !isFromMainThread) {
        const parent = state.agentStack[state.agentStack.length - 1];
        if (!parent.children) parent.children = [];
        parent.children.push(tool);
      } else {
        state.pendingToolUses.push(tool);
        state.pendingBlocks.push({ type: "tool_use", toolUse: tool });
      }

      if (isAgent) {
        state.agentStack.push(tool);
      }
    } else if (event.type === "tool_result") {
      const agentIdx = state.agentStack.findIndex((a) => a.id === event.toolId);
      if (agentIdx !== -1) {
        state.agentStack[agentIdx].output = event.toolOutput || "";
        if (event.filePath) state.agentStack[agentIdx].filePath = event.filePath;
        state.agentStack[agentIdx].status = "done";
        state.agentStack.splice(agentIdx, 1);
      } else if (state.agentStack.length > 0) {
        for (const agent of state.agentStack) {
          const child = agent.children?.find((t) => t.id === event.toolId);
          if (child) {
            child.output = event.toolOutput || "";
            if (event.filePath) child.filePath = event.filePath;
            child.status = "done";
            break;
          }
        }
      } else {
        const tool = state.pendingToolUses.find((t) => t.id === event.toolId);
        if (tool) {
          tool.output = event.toolOutput || "";
          if (event.filePath) tool.filePath = event.filePath;
          tool.status = "done";
        }
      }
      state.thinkingStartedAt = Date.now();
    } else if (event.type === "tool_progress" && event.toolId && event.text) {
      const agent = state.agentStack.find((a) => a.id === event.toolId);
      if (agent) {
        agent.output += event.text;
      } else if (state.agentStack.length > 0) {
        let found = false;
        for (const a of state.agentStack) {
          const child = a.children?.find((t) => t.id === event.toolId);
          if (child) {
            child.output += event.text;
            found = true;
            break;
          }
        }
        if (!found) {
          const tool = state.pendingToolUses.find((t) => t.id === event.toolId);
          if (tool) tool.output += event.text;
        }
      } else {
        const tool = state.pendingToolUses.find((t) => t.id === event.toolId);
        if (tool) tool.output += event.text;
      }
    } else if (event.type === "system_message" && event.text) {
      const permModePrefix = "__permission_mode::";
      if (event.text.startsWith(permModePrefix)) {
        result.systemMessages.push(event.text);
        continue;
      }
      result.systemMessages.push(event.text);
    } else if (event.type === "message_done" && event.message) {
      if (state.thinkingStartedAt !== null && state.pendingBlocks.some((b) => b.type === "thinking")) {
        const durationMs = Date.now() - state.thinkingStartedAt;
        for (const block of state.pendingBlocks) {
          if (block.type === "thinking") block.durationMs = durationMs;
        }
        result.emit.push({ type: "thinking", durationMs });
      }
      state.thinkingStartedAt = null;
      if (event.interrupted) {
        if (state.currentAssistantMsgId) {
          event.message.id = state.currentAssistantMsgId;
        }
        if (state.pendingBlocks.length > 0) {
          event.message.blocks = [...state.pendingBlocks];
          event.message.content = state.pendingBlocks
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
        }
        if (state.pendingToolUses.length > 0 && event.message.toolUses.length === 0) {
          event.message.toolUses = [...state.pendingToolUses];
        }
        state.pendingBlocks.length = 0;
        state.pendingToolUses.length = 0;
        state.agentStack.length = 0;
        state.currentAssistantMsgId = null;
        result.statusChange = "idle";
        state.flushedOnMessageDone = true;
        result.emit.push(event);
        result.snapshot = null;
        continue;
      }

      if (state.pendingBlocks.length === 0 && state.pendingToolUses.length === 0 && state.currentAssistantMsgId) {
        state.currentAssistantMsgId = null;
        result.statusChange = "idle";
        if (options.compacting) result.compactDone = true;
        state.flushedOnMessageDone = true;
        result.snapshot = null;
        continue;
      }

      if (state.currentAssistantMsgId) {
        event.message.id = state.currentAssistantMsgId;
      }
      const hasStreamedText = state.pendingBlocks.some((b) => b.type === "text");
      if (event.message.content && !hasStreamedText) {
        state.pendingBlocks.push({ type: "text", text: event.message.content });
      }

      if (state.pendingToolUses.length === 0) {
        const fullText = state.pendingBlocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();

        if (fullText === "No response requested.") {
          state.pendingBlocks.length = 0;
          state.currentAssistantMsgId = null;
          result.statusChange = "idle";
          state.flushedOnMessageDone = true;
          result.snapshot = null;
          continue;
        }

        const apiErrMatch = fullText.match(/^API Error: (\d+)\s/);
        if (apiErrMatch) {
          const msgMatch = fullText.match(/"message"\s*:\s*"([^"]+)"/);
          const errMsg = msgMatch ? `${msgMatch[1]} (HTTP ${apiErrMatch[1]})` : fullText.slice(0, 200);
          state.pendingBlocks.length = 0;
          state.pendingToolUses.length = 0;
          state.agentStack.length = 0;
          state.currentAssistantMsgId = null;
          result.statusChange = "idle";
          result.errors.push(errMsg);
          state.flushedOnMessageDone = true;
          result.snapshot = null;
          continue;
        }
      }

      event.message.blocks = [...state.pendingBlocks];
      if (event.message.toolUses.length === 0 && state.pendingToolUses.length > 0) {
        event.message.toolUses = [...state.pendingToolUses];
      }
      state.pendingToolUses.length = 0;
      state.pendingBlocks.length = 0;
      state.agentStack.length = 0;
      state.currentAssistantMsgId = null;
      result.statusChange = "idle";
      if (options.compacting) result.compactDone = true;
      state.flushedOnMessageDone = true;
    }

    if (event.type === "permission_request" && event.requestId) {
      const toolName = event.toolName || "";
      if (options.planMode) {
        if (toolName === "Bash") {
          const cmd = (event.rawToolInput as { command?: string })?.command ?? "";
          if (isReadOnlyBashCommand(cmd)) {
            result.permissionActions.push({ type: "auto_approve", requestId: event.requestId, toolName, rawToolInput: event.rawToolInput });
            continue;
          }
          result.permissionActions.push({
            type: "auto_deny",
            requestId: event.requestId,
            toolName,
            denyReason: `Cockpit plan mode: Bash is restricted to read-only commands (ls, cat, head, tail, wc, grep, rg, find, stat, file, du, df, tree, git status/log/diff/show/blame, etc.). Shell operators ';', '&&', '||', '>', '<', '$(...)', backticks are not allowed. Use Read/Grep/Glob for file access, or call ExitPlanMode when ready to implement.`,
          });
          continue;
        }
        if (WRITE_TOOLS.has(toolName)) {
          result.permissionActions.push({
            type: "auto_deny",
            requestId: event.requestId,
            toolName,
            denyReason: `Cockpit plan mode: ${toolName} is blocked. Plan mode is read-only; call ExitPlanMode to submit the plan before making changes.`,
          });
          continue;
        }
        if (!USER_FACING_TOOLS.has(toolName)) {
          result.permissionActions.push({ type: "auto_approve", requestId: event.requestId, toolName, rawToolInput: event.rawToolInput });
          continue;
        }
      }
      if (toolName === "Bash" && event.rawToolInput) {
        const cmd = (event.rawToolInput as { command?: string }).command || "";
        if (cmd.trimStart().startsWith("gh ")) {
          result.permissionActions.push({ type: "auto_approve", requestId: event.requestId, toolName, rawToolInput: event.rawToolInput });
          continue;
        }
      }
      result.permissionActions.push({
        type: "store",
        requestId: event.requestId,
        toolName,
        toolInput: event.toolInput,
        rawToolInput: event.rawToolInput,
        permissionSuggestions: event.permissionSuggestions,
      });
    }

    result.emit.push(event);
    result.snapshot = buildSnapshot(state);
  }

  return result;
}
