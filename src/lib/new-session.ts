import { defaultSelectionFor } from "@/lib/model-picker";
import { type ContextSize, resolveModel } from "@/lib/models";
import type { Provider, SandboxConfig, SessionNotifications, SessionPermissionMode, ThinkingLevel } from "@/types";

/**
 * The decisions the new-session dialog makes, kept out of the component so
 * they can be tested: what a fresh draft inherits from Session Defaults, which
 * models can run Auto permissions, and the body both entry points POST.
 */

export type SessionRuntime = "pty" | "stream";

export interface NewSessionInput {
  cwd: string;
  name?: string;
  runtime: SessionRuntime;
  model?: string;
  contextSize?: ContextSize;
  thinkingLevel?: ThinkingLevel;
  permissionMode?: SessionPermissionMode;
  sandbox?: SandboxConfig;
  notifications?: SessionNotifications | null;
}

/** What the dialog edits on its second step. */
export interface NewSessionDraft {
  model: string;
  contextSize: ContextSize;
  thinkingLevel: ThinkingLevel;
  permissionMode: SessionPermissionMode;
  sandbox: SandboxConfig;
  notifications: SessionNotifications | null;
}

/** The slice of AppDefaults a draft is seeded from, structurally, so this
 *  module does not import the settings hook. */
export interface SessionDefaultsLike {
  modelSlots: { main?: string; mainContext?: ContextSize };
  thinkingLevel: ThinkingLevel;
  permissionMode: SessionPermissionMode;
  sandbox: SandboxConfig;
}

/**
 * Whether a model runs on Anthropic, which Auto permissions need. A
 * provider-qualified id names its provider, so only `anthropic:` qualifies; a
 * bare id counts when it is a catalogue model or no connected provider claims
 * it, matching the server's rule that an unclaimed id is Anthropic's.
 */
export function modelIsAnthropic(model: string, providers: Provider[] | undefined): boolean {
  const base = model.replace(/\[.*\]$/, "");
  const colon = base.indexOf(":");
  if (colon > 0) return base.slice(0, colon) === "anthropic";
  if (resolveModel(base)) return true;
  return !(providers ?? []).some((p) => p.models.some((m) => m.modelId === base));
}

/** Auto drops to Manual on a model that cannot run its classifier. */
export function clampPermissionMode(mode: SessionPermissionMode, model: string, providers: Provider[] | undefined): SessionPermissionMode {
  return mode === "auto" && !modelIsAnthropic(model, providers) ? "manual" : mode;
}

/** What step two starts with: the Session Defaults, settled against the model
 *  that will actually run, with notifications off as they are for any session
 *  that does not ask for them. */
export function draftFromDefaults(settings: SessionDefaultsLike, providers?: Provider[], allowSonnet1m = false): NewSessionDraft {
  const model = settings.modelSlots.main || "sonnet";
  const settled = defaultSelectionFor(
    model,
    { contextSize: settings.modelSlots.mainContext ?? "200k", thinkingLevel: settings.thinkingLevel },
    providers,
    allowSonnet1m,
  );
  return {
    model: settled.model,
    contextSize: settled.contextSize,
    thinkingLevel: settled.thinkingLevel,
    permissionMode: clampPermissionMode(settings.permissionMode, settled.model, providers),
    sandbox: settings.sandbox,
    notifications: null,
  };
}

/** A model pick keeps the context and thinking choices where the new model can
 *  run them, and re-settles the permission mode Auto rules. */
export function applyModelPick(
  draft: NewSessionDraft,
  value: string,
  providers: Provider[] | undefined,
  allowSonnet1m = false,
): NewSessionDraft {
  const settled = defaultSelectionFor(
    value,
    { contextSize: draft.contextSize, thinkingLevel: draft.thinkingLevel },
    providers,
    allowSonnet1m,
  );
  return {
    ...draft,
    model: settled.model,
    contextSize: settled.contextSize,
    thinkingLevel: settled.thinkingLevel,
    permissionMode: clampPermissionMode(draft.permissionMode, settled.model, providers),
  };
}

/** The POST body both entry points send: empty name, absent notifications and
 *  unset draft fields are left out rather than sent as null. */
export function newSessionBody(input: NewSessionInput): Record<string, unknown> {
  const name = input.name?.trim();
  return {
    cwd: input.cwd.trim(),
    ...(name ? { name } : {}),
    runtime: input.runtime,
    ...(input.model ? { model: input.model } : {}),
    ...(input.contextSize ? { contextSize: input.contextSize } : {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    ...(input.sandbox ? { sandbox: input.sandbox } : {}),
    ...(input.notifications ? { notifications: input.notifications } : {}),
  };
}
