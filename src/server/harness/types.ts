import type { ContextSize } from "@/lib/models";
import type { ParsedEvent } from "@/server/event-parser";
import type { SessionRuntime } from "@/server/session-prefs";
import type {
  ChatMessage,
  DocumentAttachment,
  ImageAttachment,
  ModelSlots,
  SandboxConfig,
  SessionPermissionMode,
  ThinkingLevel,
} from "@/types";

// One member today on purpose: this is the seam a second harness (Codex) plugs
// into later. Widen the union and add a HARNESS_REGISTRY entry when it lands.
export type HarnessId = "claude";

export interface HarnessCapabilities {
  supportsPty: boolean;
  supportsSkills: boolean;
  supportsSlashCommands: boolean;
  supportsSubagents: boolean;
  supportsHooks: boolean;
  supportsMcp: boolean;
  supportsPlanMode: boolean;
  supportsEffort: boolean;
}

export interface Harness {
  id: HarnessId;
  displayName: string;
  capabilities: HarnessCapabilities;
  transports: SessionRuntime[];
}

/** Callback bodies live in SessionManager (unchanged business logic); the
 *  adapter only ever invokes them, in the same order it does today: a raw
 *  line first (for the usage/control-response side channel), then whatever
 *  ParsedEvents that line produced. */
export interface HarnessProcessCallbacks {
  onRawLine?(line: string): void;
  onParsedEvents(events: ParsedEvent[]): void;
  onError(message: string): void;
  onExit(info: { code: number | null; signal?: string | null }): void;
  /** PTY-only: fed by tailing the harness's on-disk transcript, its one source
   *  of truth for content since it has no structured stdout to parse. */
  onTranscriptUpdate?(messages: ChatMessage[], lastUsage: { used: number } | null): void;
}

/** Fully-resolved spawn config. SessionManager decides *what* to run (model
 *  resolution, provider env vars, MCP config, effort, plan-mode reminder);
 *  the adapter only decides *how* to invoke its CLI to get there. */
export interface HarnessSpawnConfig {
  sessionId: string;
  cwd: string;
  cliSessionId: string;
  willResume: boolean;
  model?: string;
  providerEnvVars?: Record<string, string>;
  /** Bare model id for the "subagent" slot, pre-resolved via resolveProviderModel
   *  when it differs from the main model. Maps to ANTHROPIC_SMALL_FAST_MODEL. */
  subagentModel?: string;
  contextSize: ContextSize;
  thinkingLevel: ThinkingLevel;
  supportsEffort: boolean;
  planMode: boolean;
  permissionMode: SessionPermissionMode;
  /** OS-level Bash sandbox; applied via the settings file on the PTY runtime. */
  sandbox?: SandboxConfig;
  cockpitAgent: boolean;
  modelSlots: ModelSlots;
  appendSystemPrompt?: string;
  mcpConfigPath?: string;
  text?: string;
  images?: ImageAttachment[];
  documents?: DocumentAttachment[];
  reminderText?: string;
  callbacks: HarnessProcessCallbacks;
}

export interface HarnessProcess {
  readonly isAlive: boolean;
  /** Settles once the transport is confirmed up (or fails to come up). Stream
   *  is synchronously alive so this resolves immediately; PTY resolves when
   *  its async start() does. SessionManager awaits this only to clear its own
   *  spawn-in-flight guard and to handle a failed spawn — it does not gate
   *  message delivery, which sendUserMessage can be called on regardless. */
  readonly ready: Promise<void>;
  sendUserMessage(text: string, images?: ImageAttachment[], documents?: DocumentAttachment[], reminderText?: string): void;
  interrupt(): void;
  /** reason is forwarded to Claude's end_session control request for its own
   *  logging; harnesses without an equivalent concept just ignore it. */
  kill(reason?: string): void;
  respondToPermission(
    requestId: string,
    allowed: boolean,
    toolInput?: Record<string, unknown>,
    permissionSuggestions?: Record<string, unknown>[],
    denyReason?: string,
  ): boolean;
  /** Raw control-protocol write (control_request-shaped JSON), when the
   *  transport has a live channel for one. Absent (not just false) tells the
   *  caller this transport can't do live updates, so it falls back to
   *  kill+respawn — this is how PTY sessions already behave for setModel and
   *  setThinkingLevel today. onResponse, when given, is invoked once with the
   *  matching control_response (keyed by payload.request_id). */
  writeControlRequest?(payload: Record<string, unknown>, onResponse?: (response: Record<string, unknown>) => void): boolean;
  /** Forget a pending onResponse registered via writeControlRequest, e.g. on
   *  caller-side timeout. */
  cancelControlRequest?(requestId: string): void;
  /** Claude-CLI convenience commands ("/compact", "/context"). Returns false
   *  (or is absent) when the transport has no equivalent, so the caller falls
   *  back to sendUserMessage or another strategy. */
  sendRawCommand?(cmd: string): boolean;
}

export interface HarnessAdapter {
  spawn(config: HarnessSpawnConfig): HarnessProcess;
}
