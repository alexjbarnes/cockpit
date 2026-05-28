# Selectable Context Window Sizes on Provider Models

Status: approved
Date: 2026-05-28

## Problem

`ProviderModel.supportsExtendedContext: boolean` and the parallel field on the built-in `MODELS` array encode a single binary capability (1M context yes/no). The selected size is then carried by appending `[1m]` to the model ID string everywhere it travels: session prefs, job records, settings, the `session:set_model` WebSocket message, the `--model` CLI argument. The suffix is parsed and rebuilt in seven different sites.

Two problems with this shape:

1. Adding a third size (`[2m]`, or a custom-provider model that only supports 1M) requires edits in every parse/build site.
2. The suffix-in-model-string convention leaks into the CLI argv. When a model with brackets ends up unquoted in a shell context (the `claude-opus-4-7[1m]` failure under zsh), the brackets are interpreted as a glob character class, causing `no matches found` startup failures.

## Goals

- Single source of truth for the catalog of context sizes.
- A list-of-sizes field on each model entry, replacing the boolean.
- Explicit `contextSize` field on stored records and the WS protocol, replacing string-suffix encoding.
- Selector UI hides when a model offers fewer than 2 sizes.
- Read-side migration of existing stored data (no shipped breakage).

## Non-goals

- Adding a third context size (`2m`). The catalog supports it but the brief lists only 200K and 1M.
- Changing the CLI's gating mechanism. `CLAUDE_CODE_DISABLE_1M_CONTEXT` remains the only switch we set.
- Migrating custom-provider config. The custom-provider feature has not shipped.

## Design

### Catalog

New const in `src/lib/models.ts`:

```ts
export const CONTEXT_SIZES = {
  "200k": { label: "200K", disableEnv: true },
  "1m":   { label: "1M",   disableEnv: false },
} as const;

export type ContextSize = keyof typeof CONTEXT_SIZES;

export const DEFAULT_CONTEXT_SIZE: ContextSize = "200k";
```

`disableEnv: true` means the spawn code sets `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` when this size is active. Adding a future size only requires extending this object.

### Type changes

`src/types/index.ts`:

```ts
export interface ProviderModel {
  modelId: string;
  displayName: string;
  effortLevels: ThinkingLevel[];
  contextSizes: ContextSize[];        // was supportsExtendedContext?: boolean
  defaultEffort?: ThinkingLevel;
}

export interface ModelSlots {
  main?: string;                       // bare modelId, no suffix
  mainContext?: ContextSize;
  subagent?: string;
  fast?: string;
}
```

Invariant: `contextSizes` is non-empty. Form validation enforces it.

`src/lib/models.ts` `ModelEntry`:

```ts
export interface ModelEntry {
  alias: ModelAlias;
  version: string;
  modelId: string;
  displayName: string;
  description: string;
  contextSizes: ContextSize[];         // was supportsExtendedContext: boolean
  contextWindow?: number;
  isDefault?: boolean;
}
```

Seed values:
- `haiku` 4.5: `["200k"]`
- `sonnet` 4.6: `["200k", "1m"]`
- `opus` 4.6: `["200k", "1m"]`
- `opus` 4.7: `["200k", "1m"]`

### Stored records

`src/server/session-prefs.ts`:

```ts
export interface SessionPrefs {
  // ...
  model?: string;                      // bare modelId, no suffix
  contextSize?: ContextSize;           // new
  modelSlots?: ModelSlots;             // ModelSlots.mainContext also new
}
```

`src/types/index.ts` `ScheduledJob`:

```ts
export interface ScheduledJob {
  // ...
  model?: string;                      // bare modelId, no suffix
  contextSize?: ContextSize;           // new
}
```

`Session.info` (line 8 area of types/index.ts) gains `contextSize?: ContextSize` alongside the existing `model?: string`.

### WebSocket protocol

```ts
| { type: "session:set_model"; sessionId: string; model: string; contextSize?: ContextSize }
| { type: "session:set_model_slot"; sessionId: string; slot: "main" | "subagent" | "fast"; modelId: string }
```

`set_model_slot` does not carry context size. Subagent and fast slots inherit main's context window via the process-wide `CLAUDE_CODE_DISABLE_1M_CONTEXT` env var (which the CLI applies uniformly to all models in the process). Only `set_model` carries `contextSize`, because that is the message the in-chat size pills emit.

When the client omits `contextSize` from `set_model` (model-only change), the server keeps the slot's existing `contextSize`. Size-only changes still carry the current `model` string verbatim, so `model` remains a required field in the message.

### Server spawn paths

`src/server/session-manager.ts`, stream spawn (around line 2090) and PTY spawn (around line 2318):

```ts
const sizeKey = session.info.contextSize ?? DEFAULT_CONTEXT_SIZE;
if (CONTEXT_SIZES[sizeKey].disableEnv) {
  env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
}
```

`session.info.model` is always a bare modelId. The `--model` argv value passed to the CLI never contains brackets, eliminating the zsh glob expansion failure.

`setModel` flip detection (around line 1037):

```ts
const contextChanged = (session.info.contextSize ?? DEFAULT_CONTEXT_SIZE)
  !== (incomingContextSize ?? session.info.contextSize ?? DEFAULT_CONTEXT_SIZE);
```

Restart on context change is preserved.

`setModel` also coerces `contextSize` when the new model does not support the current size: if the incoming `contextSize` (or, when omitted, the persisted one) is not in the new model's `contextSizes`, fall back to that model's first entry. The coercion happens server-side so any client that forgets to update the field gets a valid configuration.

### Form UX (provider-form.tsx)

`EditingModel` state:

```ts
interface EditingModel {
  index: number;
  modelId: string;
  displayName: string;
  effortLevels: ThinkingLevel[];
  contextSizes: ContextSize[];          // was supportsExtendedContext: boolean
}
```

Render a `ContextSizePills` component next to the existing `EffortPills` row, with the same visual style. Each entry in `CONTEXT_SIZES` is a toggleable pill. Both 200K and 1M are independently selectable: a custom provider can advertise a 1M-only model.

Validation: Save and Add buttons disabled when `contextSizes.length === 0`. Empty arrays are rejected at the server boundary in `providers.ts`.

Display in the collapsed model row: render every non-`200k` size as a label (e.g. `1M`). When `contextSizes` is exactly `["200k"]`, no label.

### Selector UX (three consumer sites)

`src/components/input-area.tsx`, `src/app/(app)/jobs/[id]/edit/page.tsx`, `src/app/(app)/settings/session/page.tsx`:

```ts
const sizes = currentEntry?.contextSizes ?? [];
if (sizes.length >= 2) {
  // render button group: one button per entry, active = current contextSize
}
```

The button group always shows when a model exposes 2+ sizes, hides otherwise.

When the model is switched and the previous `contextSize` is not in the new model's `contextSizes`, the selector defaults to the first entry in the new model's list.

### In-chat /model picker (model-picker.tsx)

Today `buildRows()` produces one row per model plus a second row per model when `supportsExtendedContext` is true (key `${id}::${modelId}[1m]`, value `${modelId}[1m]`).

New: one row per model. When the row's `contextSizes.length >= 2`, render the size pills inline on that row (right-aligned, similar to the version pills). Clicking a model row alone keeps the current context size. Clicking a size pill emits `set_model` with the new size while keeping the same model.

The `onSelect(model: string)` signature changes to `onSelect(model: string, contextSize?: ContextSize)`. Callers (`use-session.ts` and similar) forward both to the server.

### Migration (read-side, passive)

New helper in `src/lib/models.ts`:

```ts
export function splitLegacyModel(stored: string | undefined): {
  model: string | undefined;
  contextSize: ContextSize;
} {
  if (!stored) return { model: undefined, contextSize: DEFAULT_CONTEXT_SIZE };
  const hasOneM = /\[1m\]$/i.test(stored);
  return {
    model: stored.replace(/\[.*\]$/, ""),
    contextSize: hasOneM ? "1m" : "200k",
  };
}
```

Apply at these read sites:

- `getSessionPrefs` in `src/server/session-prefs.ts`: split `prefs.model` and `prefs.modelSlots.main` if either still contains a suffix. The split-out `contextSize` populates `prefs.contextSize` (and `modelSlots.mainContext`) if not already set.
- `getJob` and the list path in `src/server/job-storage.ts`: split `job.model` similarly.
- `use-settings.ts` initial load (existing migration block at line 60-64): extend to split `modelSlots.main`.

Subsequent writes use the new shape. The suffix dies on first save after upgrade. No batch rewrite, no startup script.

### Cleanup (deletions after migration is in place)

- `supportsExtendedContext` from `ProviderModel`, `ModelEntry`, and `toProviderModels`.
- The local helpers `hasExtendedContext`, `parseModelString`, `buildModelString`, `baseModel` in `input-area.tsx`, `model-picker.tsx`, `settings/session/page.tsx`, `jobs/[id]/edit/page.tsx`.
- All `${modelId}[1m]` concatenations.
- `/\[1m\]/i.test(...)` checks in `session-manager.ts` at lines 1040, 2110, 2332.

`splitLegacyModel` stays in the codebase indefinitely. Production data may contain legacy strings for the lifetime of the installation.

## Testing

- Unit test `splitLegacyModel`: handles undefined, bare modelId, `claude-opus-4-7[1m]`, `sonnet[1m]`, malformed `[xyz]`.
- Provider form: pill validation rejects empty `contextSizes`.
- Spawn path: a session with `contextSize: "200k"` sets the env var, with `"1m"` does not, regardless of any legacy suffix that may still be in `session.info.model`.
- Read-side migration: `session-prefs.json` containing `"model": "claude-opus-4-7[1m]"` produces `{ model: "claude-opus-4-7", contextSize: "1m" }` in memory.
- WS round-trip: `session:set_model` with `contextSize: "1m"` updates both fields in `SessionPrefs`.

## Affected files

Frontend:
- `src/types/index.ts`
- `src/lib/models.ts`
- `src/components/provider-form.tsx`
- `src/components/model-picker.tsx`
- `src/components/input-area.tsx`
- `src/app/(app)/jobs/[id]/edit/page.tsx`
- `src/app/(app)/settings/session/page.tsx`
- `src/hooks/use-session.ts`
- `src/hooks/use-settings.ts`

Backend:
- `src/server/session-manager.ts`
- `src/server/session-prefs.ts`
- `src/server/job-storage.ts`
- `src/server/ws-handler.ts`
- `src/server/providers.ts` (validation only)

## Open questions

None.
