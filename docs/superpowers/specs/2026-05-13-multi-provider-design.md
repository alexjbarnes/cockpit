# Multi-Provider Model Support

Support configuring multiple model providers in cockpit. Each provider is a named set of environment variables and a list of available models. Sessions can select models from any configured provider, with per-slot assignment (main, subagent, fast). Cockpit injects the provider's env vars at CLI spawn time without understanding the provider's protocol.

## Provider Data Model

```typescript
interface Provider {
  id: string;              // "anthropic" for built-in, UUID for custom
  name: string;            // "Anthropic", "OpenRouter", "My Proxy"
  envVars: Record<string, string>;
  models: ProviderModel[];
  isBuiltin?: boolean;     // true for Anthropic, prevents deletion
}

interface ProviderModel {
  modelId: string;         // passed to --model, e.g. "deepseek/deepseek-chat"
  displayName: string;     // shown in UI, e.g. "DeepSeek Chat"
  effortLevels: ThinkingLevel[];  // which levels appear in selector, empty = no thinking
  supportsExtendedContext?: boolean;  // [1m] toggle, default false
  defaultEffort?: ThinkingLevel;     // pre-selected effort for this model
}

type ThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";
```

### Built-in Anthropic provider

- `id: "anthropic"`, `isBuiltin: true`
- `envVars: {}` (inherits from shell environment)
- `models`: auto-populated from the existing `MODELS` array in `src/lib/models.ts`
- Not deletable. Users can add env var overrides to point at a different endpoint.
- Effort levels derived from existing `allowedEffortLevels()` logic at merge time.

### Storage

File: `~/.cockpit/providers.json` (array of `Provider` objects).

The Anthropic provider is not stored in the file. It exists as a hardcoded fallback merged at read time. Deleting the file does not break anything.

## Session Model Slots

Sessions track three model slots instead of a single model string.

```typescript
interface ModelSlots {
  main?: string;       // e.g. "claude-opus-4-7"
  subagent?: string;   // defaults to main if not set
  fast?: string;       // defaults to main if not set
}
```

Added to `SessionPrefs`:

```typescript
interface SessionPrefs {
  // existing fields unchanged
  model?: string;          // kept for backwards compat, maps to main slot
  modelSlots?: ModelSlots;
}
```

Resolution: if `modelSlots` exists, use it. If only `model` exists (old sessions), treat as `{ main: model }`. Subagent and fast default to main when unset.

## Server Layer

### New file: `src/server/providers.ts`

Manages `~/.cockpit/providers.json`. Same pattern as `defaults.ts` (sync read/write, in-memory cache).

```typescript
function getProviders(): Provider[]
function setProviders(providers: Provider[]): void
function getProvider(id: string): Provider | undefined
function addProvider(provider: Omit<Provider, "id">): Provider
function updateProvider(id: string, partial: Partial<Provider>): Provider
function deleteProvider(id: string): void  // throws if isBuiltin
function resolveProviderModel(modelId: string): { provider: Provider; model: ProviderModel } | null
```

`resolveProviderModel` is the central model lookup. Scans all providers (Anthropic first) and returns the first match. If a model ID appears in multiple providers, Anthropic wins. To use the same model ID from a different provider, the session stores `providerId:modelId` as the qualified form. Unqualified model IDs resolve via scan order. Used everywhere the app needs effort levels, context support, or which env vars to inject.

### API routes: `src/app/api/providers/route.ts`

- `GET /api/providers` - returns all providers (Anthropic merged in)
- `POST /api/providers` - create a new provider

### API routes: `src/app/api/providers/[id]/route.ts`

- `PUT /api/providers/[id]` - update provider
- `DELETE /api/providers/[id]` - delete provider (rejects builtin)

## Session Manager Changes

### `spawnProcess()` (session-manager.ts)

Currently builds env from `process.env` and sets `CLAUDE_CODE_DISABLE_1M_CONTEXT`.

New behavior:

1. Resolve the main slot's model via `resolveProviderModel()`
2. Merge that provider's `envVars` into the spawn environment
3. Set `--model` from `modelSlots.main`
4. If `modelSlots.subagent` differs from main, set `ANTHROPIC_SMALL_FAST_MODEL` env var
5. Keep `CLAUDE_CODE_DISABLE_1M_CONTEXT` logic, driven by model's `supportsExtendedContext`

### `setModel()` becomes `setModelSlot(sessionId, slot, modelId)`

- Updates the specific slot in session prefs
- Main slot: same respawn/control_request logic as today (respawn if provider env vars change or context window changes, control_request otherwise)
- Subagent/fast slots: always respawn (env vars set at spawn time only)
- Respawn warning shown client-side before sending the request

## Defaults Changes

`AppDefaults` in `defaults.ts`:

```typescript
interface AppDefaults {
  // existing UI prefs unchanged
  modelSlots: ModelSlots;    // replaces model: string
  thinkingLevel: ThinkingLevel;
}
```

Migration: if `defaults.json` has `model` (old format), read as `{ main: model }`. Drop the old key on next write.

## WebSocket Protocol

Current: `session:set_model` with `{ sessionId, model }`.

New: `session:set_model_slot` with `{ sessionId, slot: "main" | "subagent" | "fast", modelId: string }`.

Client shows confirmation dialog before sending if the change requires a respawn (provider change or context window change).

## UI Changes

### Settings page: Provider management

New "Providers" section in settings (or separate `/settings/providers` page).

- List configured providers with expand/collapse
- Each provider shows: name, env var count, model count
- Add/edit form: name, env var key-value editor, model list editor
- Model editor fields: modelId, displayName, effort level checkboxes (low/medium/high/xhigh/max), extended context toggle, default effort dropdown
- Anthropic provider shown but locked (not deletable, models read-only)

### Model picker (`model-picker.tsx`)

- Fetches all providers and builds a grouped list
- Groups by provider name: "Anthropic", "OpenRouter", etc.
- Anthropic models keep current rich rendering (context toggle, version buttons)
- Custom provider models render as plain rows (modelId + displayName)
- Picker needs to know which slot is being set (main/subagent/fast)

### Session header thinking selector

- Currently calls `allowedEffortLevels(resolveModel(model))`
- Changes to look up model via `resolveProviderModel()` and read `effortLevels`
- Empty array: hide thinking selector

### Job scheduler

- Job model selector uses the unified model list from all providers
- Job config gains `modelSlots` to match session config

## What stays unchanged

- `src/lib/models.ts` stays as-is. Becomes the data source for the built-in Anthropic provider's model list. `allowedEffortLevels()` and `resolveModel()` still work for Anthropic models.
- Auth system, tab system, sidebar, changes view: untouched.
- Claude Code CLI interface: unchanged. Cockpit controls env vars and `--model` arg.

## Future: proxy mode

This design anticipates a local translation proxy. When a proxy is added:

- All providers' env vars move from CLI spawn env to proxy routing config
- `ANTHROPIC_BASE_URL` points at `localhost:proxy_port` for all sessions
- Model names become routing keys (proxy resolves provider by model ID)
- Per-slot models work across providers (proxy routes each request independently)
- Provider config in `providers.json` is shared between cockpit and proxy

The provider data model, model slots, and UI work identically in both modes. Only the env var injection in `spawnProcess()` changes.
