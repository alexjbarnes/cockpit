import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { CONTEXT_SIZES, DEFAULT_CONTEXT_SIZE } from "@/lib/models";
import { getClaudeBin, supportedPermissionModes } from "@/server/claude-bin";
import { getCockpitCacheDir } from "@/server/paths";
import { PtyRuntime } from "@/server/pty-runtime";
import { getHookRouter } from "@/server/singleton";
import { TranscriptWatcher } from "@/server/transcript-watcher";
import type { DocumentAttachment, ImageAttachment } from "@/types";
import type { HarnessAdapter, HarnessProcess, HarnessSpawnConfig } from "./types";

const MEDIA_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

// Attachments can't be embedded inline in a PTY's raw keystrokes the way a
// stream-mode JSON content block can, so they're written to a cache dir and
// referenced by path in the typed text. Moved out of SessionManager's
// writeAttachments/cleanupAttachments/buildPtyText, now private per-process
// state instead of living on the shared Session object — nothing outside
// those three functions ever read it.
function writeAttachments(images?: ImageAttachment[], documents?: DocumentAttachment[]): string[] {
  if (!images?.length && !documents?.length) return [];
  const dir = path.join(getCockpitCacheDir(), "attachments");
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (const img of images ?? []) {
    const p = path.join(dir, `${uuidv4()}${MEDIA_EXT[img.mediaType] || ".png"}`);
    writeFileSync(p, Buffer.from(img.data, "base64"));
    paths.push(p);
  }
  for (const doc of documents ?? []) {
    const p = path.join(dir, `${uuidv4()}${MEDIA_EXT[doc.mediaType] || ".pdf"}`);
    writeFileSync(p, Buffer.from(doc.data, "base64"));
    paths.push(p);
  }
  return paths;
}

function buildPtyText(text: string, attachmentPaths: string[]): string {
  if (attachmentPaths.length === 0) return text;
  const refs = attachmentPaths.map((p) => `[Attached image: ${p}]`).join("\n");
  return `${refs}\n${text}`;
}

class ClaudePtyProcess implements HarnessProcess {
  private runtime: PtyRuntime;
  private watcher: TranscriptWatcher;
  private attachmentPaths: string[];
  readonly ready: Promise<void>;

  constructor(runtime: PtyRuntime, watcher: TranscriptWatcher, ready: Promise<void>, initialAttachmentPaths: string[]) {
    this.runtime = runtime;
    this.watcher = watcher;
    this.ready = ready;
    this.attachmentPaths = initialAttachmentPaths;
  }

  get isAlive(): boolean {
    return this.runtime.isAlive;
  }

  stopWatcher(): void {
    this.watcher.stop();
  }

  private cleanupAttachments(): void {
    for (const p of this.attachmentPaths) {
      try {
        unlinkSync(p);
      } catch {
        // file already cleaned up
      }
    }
    this.attachmentPaths = [];
  }

  sendUserMessage(text: string, images?: ImageAttachment[], documents?: DocumentAttachment[]): void {
    this.cleanupAttachments();
    const attachments = writeAttachments(images, documents);
    this.attachmentPaths.push(...attachments);
    this.runtime.sendUserText(buildPtyText(text, attachments)).catch(() => {
      // best effort — mirrors the original swallow-and-log-only behavior
    });
  }

  interrupt(): void {
    this.runtime.interrupt();
  }

  kill(): void {
    this.stopWatcher();
    this.runtime.kill().catch(() => {});
  }

  respondToPermission(
    requestId: string,
    allowed: boolean,
    toolInput?: Record<string, unknown>,
    _permissionSuggestions?: unknown,
    denyReason?: string,
  ): boolean {
    return this.runtime.notifyPermissionDecision(
      requestId,
      allowed
        ? { behavior: "allow", ...(toolInput ? { updatedInput: toolInput } : {}) }
        : { behavior: "deny", message: denyReason ?? "User denied" },
    );
  }

  sendRawCommand(cmd: string): boolean {
    if (!this.runtime.isAlive) return false;
    this.runtime.sendText(cmd).catch(() => {});
    return true;
  }
}

export class ClaudePtyAdapter implements HarnessAdapter {
  spawn(config: HarnessSpawnConfig): HarnessProcess {
    const hookRouter = getHookRouter();
    if (!hookRouter) {
      throw new Error("PTY runtime requires the hook router; server boot did not register one");
    }

    mkdirSync(config.cwd, { recursive: true });

    const extraArgs: string[] = [config.willResume ? "--resume" : "--session-id", config.cliSessionId];
    if (config.model) extraArgs.push("--model", config.model);
    // "off" is applied via the settings file (alwaysThinkingEnabled:false)
    // passed to PtyRuntime below, not --effort (which has no "off" value).
    if (config.supportsEffort && config.thinkingLevel !== "off") {
      extraArgs.push("--effort", config.thinkingLevel);
    }
    if (config.planMode) {
      extraArgs.push("--permission-mode", "plan");
    } else if (config.permissionMode === "bypass" && !config.cockpitAgent) {
      extraArgs.push("--permission-mode", "bypassPermissions");
    } else if (config.permissionMode === "auto" && supportedPermissionModes().has("auto")) {
      // Auto hands permission judgement to the CLI's own safety classifier: it
      // runs on the session's model, auto-approves plan-safe calls, and fires
      // the PermissionRequest hook (cockpit's cards) only for the rest. The
      // session-manager only offers this for Anthropic models — the classifier
      // is unreliable and slow on non-Anthropic ones — and downgrades to manual
      // otherwise, so an "auto" reaching here is already Anthropic-gated. When
      // the CLI build has no "auto" choice, fall through to manual.
      extraArgs.push("--permission-mode", "auto");
    } else if (supportedPermissionModes().has("manual")) {
      // Ask for manual explicitly rather than letting the CLI pick. Its default
      // is now `auto`, whose safety classifier runs on the SESSION's model — on
      // a slow non-Anthropic one it times out and blocks the tool call outright
      // ("Update blocked five times running: auto-mode safety classifier down"
      // on glm-5.3-flash). Manual is also simply the right mode for cockpit:
      // permissions are its own job, answered through its cards over the
      // PermissionRequest hook, not delegated to a classifier that bypasses
      // that UI entirely.
      //
      // Guarded on support because the name is version-dependent — an older
      // build rejects the choice and the spawn dies. Unsupported means no flag,
      // which is exactly what cockpit did before.
      extraArgs.push("--permission-mode", "manual");
    }
    if (config.cockpitAgent && config.appendSystemPrompt) {
      extraArgs.push("--append-system-prompt", config.appendSystemPrompt);
    }
    if (config.mcpConfigPath) {
      extraArgs.push("--mcp-config", config.mcpConfigPath);
    }

    const extraEnv: Record<string, string> = {};
    if (config.providerEnvVars) Object.assign(extraEnv, config.providerEnvVars);
    const sizeKey = config.contextSize ?? DEFAULT_CONTEXT_SIZE;
    if (CONTEXT_SIZES[sizeKey].disableEnv) {
      extraEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
    }
    if (config.subagentModel) {
      extraEnv.ANTHROPIC_SMALL_FAST_MODEL = config.subagentModel;
    }

    const attachments = writeAttachments(config.images, config.documents);
    const ptyText = config.text ? buildPtyText(config.text, attachments) : config.text;

    const runtime = new PtyRuntime({
      sessionId: config.sessionId,
      cwd: config.cwd,
      cliSessionId: config.cliSessionId,
      hookRouter,
      claudeBin: getClaudeBin(),
      extraArgs,
      extraEnv,
      thinkingEnabled: config.thinkingLevel !== "off",
      // Mirrors the --permission-mode arg above, so the runtime can spot the
      // CLI silently running in a different mode than requested.
      expectedPermissionMode: config.planMode
        ? "plan"
        : config.permissionMode === "bypass" && !config.cockpitAgent
          ? "bypassPermissions"
          : config.permissionMode === "auto" && supportedPermissionModes().has("auto")
            ? "auto"
            : "manual",
      onEvents: (events) => config.callbacks.onParsedEvents(events),
      onError: (err) => config.callbacks.onError(err),
      onExit: ({ exitCode, signal }) => {
        handle.stopWatcher();
        config.callbacks.onExit({ code: exitCode, signal: signal != null ? String(signal) : null });
      },
    });

    const watcher = new TranscriptWatcher(config.cliSessionId, config.cwd, (messages, lastUsage) => {
      config.callbacks.onTranscriptUpdate?.(messages, lastUsage);
    });

    const ready = runtime
      .start(ptyText)
      .then(() => {
        watcher.start();
      })
      .catch((err: unknown) => {
        watcher.stop();
        throw err instanceof Error ? err : new Error(String(err));
      });

    const handle = new ClaudePtyProcess(runtime, watcher, ready, attachments);
    return handle;
  }
}
