import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { CONTEXT_SIZES, DEFAULT_CONTEXT_SIZE } from "@/lib/models";
import { getClaudeBin } from "@/server/claude-bin";
import { EventParser } from "@/server/event-parser";
import type { DocumentAttachment, ImageAttachment } from "@/types";
import type { HarnessAdapter, HarnessProcess, HarnessSpawnConfig } from "./types";

// Anthropic content-block shape for a user turn (text/image/document blocks).
// Moved verbatim out of SessionManager.buildContent — the plan-mode reminder
// text is now resolved by the caller and passed in, everything else is
// unchanged.
export function buildContent(
  text: string,
  images?: ImageAttachment[],
  documents?: DocumentAttachment[],
  reminderText?: string,
): string | Record<string, unknown>[] {
  if (!images?.length && !documents?.length && !reminderText) return text;

  const blocks: Record<string, unknown>[] = [];
  if (reminderText) blocks.push({ type: "text", text: reminderText });
  for (const img of images ?? []) {
    blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  }
  for (const doc of documents ?? []) {
    blocks.push({ type: "document", source: { type: "base64", media_type: doc.mediaType, data: doc.data } });
  }
  if (text) blocks.push({ type: "text", text });
  return blocks;
}

function killProcessGroup(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-proc.pid, "SIGTERM");
    }
  } catch {
    /* best effort */
  }
}

class ClaudeStreamProcess implements HarnessProcess {
  private proc: ChildProcess;
  private controlCallbacks = new Map<string, (response: Record<string, unknown>) => void>();
  private alive = true;
  readonly ready: Promise<void> = Promise.resolve();

  constructor(proc: ChildProcess) {
    this.proc = proc;
  }

  get isAlive(): boolean {
    return this.alive && this.proc.stdin !== null;
  }

  private write(payload: Record<string, unknown>): boolean {
    if (!this.proc.stdin) return false;
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
    return true;
  }

  sendUserMessage(text: string, images?: ImageAttachment[], documents?: DocumentAttachment[], reminderText?: string): void {
    const content = buildContent(text, images, documents, reminderText);
    this.write({ type: "user", message: { role: "user", content } });
  }

  interrupt(): void {
    if (this.write({ type: "control_request", request_id: `interrupt-${Date.now()}`, request: { subtype: "interrupt" } })) return;
    // Fallback: if stdin is gone, kill the process group.
    killProcessGroup(this.proc);
  }

  kill(reason?: string): void {
    // Graceful shutdown: ask the CLI to end the session over stdin so it aborts
    // any in-flight API call and cleans up. Falls back to SIGTERM if it doesn't
    // exit within the timeout.
    const sent = this.write({
      type: "control_request",
      request_id: `end-session-${Date.now()}`,
      request: { subtype: "end_session", reason },
    });
    if (!sent) {
      killProcessGroup(this.proc);
      return;
    }
    const fallback = setTimeout(() => killProcessGroup(this.proc), 3000);
    this.proc.once("close", () => clearTimeout(fallback));
  }

  respondToPermission(
    requestId: string,
    allowed: boolean,
    toolInput?: Record<string, unknown>,
    permissionSuggestions?: Record<string, unknown>[],
    denyReason?: string,
  ): boolean {
    return this.write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: allowed
          ? {
              behavior: "allow",
              updatedInput: toolInput ?? {},
              ...(permissionSuggestions?.length ? { updatedPermissions: permissionSuggestions } : {}),
            }
          : { behavior: "deny", message: denyReason ?? "User denied" },
      },
    });
  }

  writeControlRequest(payload: Record<string, unknown>, onResponse?: (response: Record<string, unknown>) => void): boolean {
    if (onResponse) {
      const requestId = payload.request_id as string | undefined;
      if (requestId) this.controlCallbacks.set(requestId, onResponse);
    }
    return this.write(payload);
  }

  cancelControlRequest(requestId: string): void {
    this.controlCallbacks.delete(requestId);
  }

  markDead(): void {
    this.alive = false;
  }

  // Used only by the adapter's own stdout handler (same module) to resolve a
  // pending writeControlRequest callback before falling through to normal
  // ParsedEvent processing. Not part of the public HarnessProcess contract.
  takeControlCallback(requestId: string): ((response: Record<string, unknown>) => void) | undefined {
    const cb = this.controlCallbacks.get(requestId);
    if (cb) this.controlCallbacks.delete(requestId);
    return cb;
  }
}

export class ClaudeStreamAdapter implements HarnessAdapter {
  spawn(config: HarnessSpawnConfig): HarnessProcess {
    const args = ["-p", "--verbose", "--output-format", "stream-json", "--input-format", "stream-json"];

    // In plan mode, omit --allow-dangerously-skip-permissions so the CLI
    // natively enforces tool restrictions and sends permission_requests for
    // write tools (which the server auto-denies). Outside plan mode, enable
    // bypass so it can be toggled mid-session.
    if (!config.planMode && !config.cockpitAgent) {
      args.push("--allow-dangerously-skip-permissions");
    }
    args.push("--permission-prompt-tool", "stdio");

    if (config.planMode) {
      args.push("--permission-mode", "plan");
    } else if (config.permissionMode === "bypass" && !config.cockpitAgent) {
      // Auto has no dedicated branch here: the stream runtime already runs with
      // --allow-dangerously-skip-permissions outside plan mode, so auto behaves
      // like manual (cockpit's cards still gate). Auto's real home is the PTY
      // runtime, which is the default.
      // Never native bypass for the assistant, even when its own bypass toggle
      // is on: the CLI would stop emitting permission requests, and cockpit
      // needs them to keep raising the config-write approval cards. Its bypass
      // is applied server-side instead, in applyProcessedResult.
      args.push("--permission-mode", "bypassPermissions");
    }

    args.push(config.willResume ? "--resume" : "--session-id", config.cliSessionId);

    if (config.model) args.push("--model", config.model);

    // "off" has no --effort value; thinking is disabled via a post-init
    // apply_flag_settings control request below instead.
    if (config.supportsEffort && config.thinkingLevel !== "off") {
      args.push("--effort", config.thinkingLevel);
    }

    if (config.cockpitAgent && config.appendSystemPrompt) {
      args.push("--append-system-prompt", config.appendSystemPrompt);
    }
    if (config.mcpConfigPath) {
      args.push("--mcp-config", config.mcpConfigPath);
    }

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    if (config.providerEnvVars) Object.assign(env, config.providerEnvVars);

    // CLAUDE_CODE_DISABLE_1M_CONTEXT is the only switch that forces a model
    // back to 200K regardless of its capability.
    const sizeKey = config.contextSize ?? DEFAULT_CONTEXT_SIZE;
    if (CONTEXT_SIZES[sizeKey].disableEnv) {
      env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
    } else {
      delete env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    }

    if (config.subagentModel) {
      env.ANTHROPIC_SMALL_FAST_MODEL = config.subagentModel;
    }

    mkdirSync(config.cwd, { recursive: true });

    const isWin = process.platform === "win32";
    const proc = spawn(getClaudeBin(), args, {
      cwd: config.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ...(isWin ? { shell: true } : { detached: true }),
    });

    const handle = new ClaudeStreamProcess(proc);

    // Initialize control request before the first user message, to get model
    // capabilities, account info, and command metadata from the CLI.
    handle.writeControlRequest({ type: "control_request", request_id: `init-${Date.now()}`, request: { subtype: "initialize" } });

    if (config.thinkingLevel === "off" && config.supportsEffort) {
      handle.writeControlRequest({
        type: "control_request",
        request_id: `thinking-off-${Date.now()}`,
        request: { subtype: "apply_flag_settings", settings: { alwaysThinkingEnabled: false } },
      });
    }

    if (config.text) {
      handle.sendUserMessage(config.text, config.images, config.documents, config.reminderText);
    }

    proc.stdin!.on("error", () => {});
    proc.stdout!.on("error", () => {});
    proc.stderr!.on("error", () => {});

    const parser = new EventParser();
    let stderrBuffer = "";
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
        if (this.tryResolveControlCallback(handle, line)) continue;
        config.callbacks.onRawLine?.(line);
        config.callbacks.onParsedEvents(parser.parseLine(line));
      }
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    proc.on("close", (code, signal) => {
      handle.markDead();
      if (lineBuffer.trim()) {
        config.callbacks.onParsedEvents(parser.parseLine(lineBuffer));
      }
      if (code !== 0 && stderrBuffer.trim()) {
        config.callbacks.onError(stderrBuffer.trim());
      }
      config.callbacks.onExit({ code, signal });
    });

    proc.on("error", (err) => {
      handle.markDead();
      config.callbacks.onError(err.message);
      config.callbacks.onExit({ code: null });
    });

    return handle;
  }

  private tryResolveControlCallback(handle: ClaudeStreamProcess, line: string): boolean {
    if (!line.includes('"control_response"')) return false;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type !== "control_response" || !parsed.request_id) return false;
      const cb = handle.takeControlCallback(parsed.request_id);
      if (!cb) return false;
      cb(parsed.response || parsed);
      return true;
    } catch {
      return false;
    }
  }
}
