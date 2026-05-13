# Multi-Provider Model Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow cockpit to manage multiple model providers (Anthropic, OpenRouter, custom proxies) with per-session model slot assignment (main, subagent, fast).

**Architecture:** Provider configs stored in `~/.cockpit/providers.json`, built-in Anthropic provider merged at read time. Sessions reference models by ID, resolved via a central `resolveProviderModel()` lookup. Provider env vars are injected into the CLI spawn environment. The model picker shows models grouped by provider.

**Tech Stack:** TypeScript, Next.js 15 App Router, Vitest, React hooks, WebSocket messaging

**Spec:** `docs/superpowers/specs/2026-05-13-multi-provider-design.md`

---

## File Map

### New files

| File | Responsibility |
|------|---------------|
| `src/server/providers.ts` | Provider CRUD, storage, `resolveProviderModel()` |
| `src/app/api/providers/route.ts` | GET (list) and POST (create) provider endpoints |
| `src/app/api/providers/[id]/route.ts` | PUT (update) and DELETE provider endpoints |
| `tests/providers.test.ts` | Unit tests for provider logic |

### Modified files

| File | What changes |
|------|-------------|
| `src/types/index.ts` | Add `Provider`, `ProviderModel`, `ModelSlots` types |
| `src/server/session-prefs.ts` | Add `modelSlots` to `SessionPrefs` |
| `src/server/defaults.ts` | Replace `model: string` with `modelSlots: ModelSlots` in `AppDefaults`, migration logic |
| `src/server/session-manager.ts` | `spawnProcess()` injects provider env vars, `setModel()` becomes `setModelSlot()` |
| `src/server/ws-handler.ts` | Handle `session:set_model_slot` message |
| `src/server/job-scheduler.ts` | Use `resolveProviderModel()` for job model config |
| `src/hooks/use-settings.ts` | `model: string` becomes `modelSlots: ModelSlots` in `Settings` |
| `src/hooks/use-session.ts` | `setModel()` becomes `setModelSlot()`, expose slot state |
| `src/components/model-picker.tsx` | Show models grouped by provider, accept slot prop |
| `src/components/input-area.tsx` | Use `resolveProviderModel()` for effort levels |
| `src/app/(app)/settings/page.tsx` | Add Providers section, update model defaults to use slots |
| `src/app/(app)/jobs/[id]/edit/page.tsx` | Use provider model list for job model selection |
| `src/lib/models.ts` | Add helper to convert `ModelEntry[]` to `ProviderModel[]` |
| `tests/defaults.test.ts` | Update for `modelSlots` migration |
| `tests/session-manager.test.ts` | Update for `setModelSlot` |
| `tests/ws-handler.test.ts` | Update for `session:set_model_slot` |

---

### Task 1: Shared types

**Files:**
- Modify: `src/types/index.ts:1-10`

- [ ] **Step 1: Add Provider, ProviderModel, and ModelSlots types**

Add at the end of `src/types/index.ts`:

```typescript
export interface ModelSlots {
  main?: string;
  subagent?: string;
  fast?: string;
}

export interface ProviderModel {
  modelId: string;
  displayName: string;
  effortLevels: ThinkingLevel[];
  supportsExtendedContext?: boolean;
  defaultEffort?: ThinkingLevel;
}

export interface Provider {
  id: string;
  name: string;
  envVars: Record<string, string>;
  models: ProviderModel[];
  isBuiltin?: boolean;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add Provider, ProviderModel, and ModelSlots types"
```

---

### Task 2: Provider server module

**Files:**
- Create: `src/server/providers.ts`
- Modify: `src/lib/models.ts`
- Create: `tests/providers.test.ts`

- [ ] **Step 1: Add `toProviderModels()` helper to models.ts**

This converts the existing hardcoded `MODELS` array into `ProviderModel[]` for the built-in Anthropic provider. Add at the end of `src/lib/models.ts`:

```typescript
import type { ProviderModel } from "@/types";

export function toProviderModels(): ProviderModel[] {
  return MODELS.map((m) => ({
    modelId: m.modelId,
    displayName: m.displayName,
    effortLevels: allowedEffortLevels(m),
    supportsExtendedContext: m.supportsExtendedContext,
    defaultEffort: recommendedEffort(m) ?? undefined,
  }));
}
```

Note: the import of `ProviderModel` needs to be added. `ThinkingLevel` is already imported from `@/types`. Check that the existing import line at the top of `models.ts` reads `import type { ThinkingLevel } from "@/types";` and expand it to `import type { ProviderModel, ThinkingLevel } from "@/types";`.

- [ ] **Step 2: Write tests for providers module**

Create `tests/providers.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("node:os", () => ({ homedir: () => "/home/user" }));
vi.mock("node:path", async () => {
  const actual = await vi.importActual("node:path");
  return { ...actual, join: (...args: string[]) => args.join("/") };
});

describe("providers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns built-in Anthropic provider when no file exists", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { getProviders } = await import("@/server/providers");
    const providers = getProviders();

    expect(providers.length).toBeGreaterThanOrEqual(1);
    const anthropic = providers.find((p) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.isBuiltin).toBe(true);
    expect(anthropic!.models.length).toBeGreaterThan(0);
  });

  it("merges custom providers with built-in Anthropic", async () => {
    const fs = await import("node:fs");
    const custom = [
      {
        id: "or-123",
        name: "OpenRouter",
        envVars: { ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1" },
        models: [{ modelId: "deepseek/deepseek-chat", displayName: "DeepSeek Chat", effortLevels: [] }],
      },
    ];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(custom));

    const { getProviders } = await import("@/server/providers");
    const providers = getProviders();

    expect(providers.length).toBe(2);
    expect(providers[0].id).toBe("anthropic");
    expect(providers[1].id).toBe("or-123");
  });

  it("resolveProviderModel finds Anthropic model", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { resolveProviderModel } = await import("@/server/providers");
    const result = resolveProviderModel("claude-opus-4-7");

    expect(result).not.toBeNull();
    expect(result!.provider.id).toBe("anthropic");
    expect(result!.model.modelId).toBe("claude-opus-4-7");
  });

  it("resolveProviderModel finds custom provider model", async () => {
    const fs = await import("node:fs");
    const custom = [
      {
        id: "or-123",
        name: "OpenRouter",
        envVars: {},
        models: [{ modelId: "deepseek/deepseek-chat", displayName: "DeepSeek Chat", effortLevels: [] }],
      },
    ];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(custom));

    const { resolveProviderModel } = await import("@/server/providers");
    const result = resolveProviderModel("deepseek/deepseek-chat");

    expect(result).not.toBeNull();
    expect(result!.provider.id).toBe("or-123");
    expect(result!.model.displayName).toBe("DeepSeek Chat");
  });

  it("resolveProviderModel returns null for unknown model", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { resolveProviderModel } = await import("@/server/providers");
    expect(resolveProviderModel("nonexistent-model")).toBeNull();
  });

  it("resolveProviderModel prefers Anthropic for duplicate model IDs", async () => {
    const fs = await import("node:fs");
    const custom = [
      {
        id: "proxy-1",
        name: "My Proxy",
        envVars: { ANTHROPIC_BASE_URL: "http://localhost:8080" },
        models: [{ modelId: "claude-opus-4-7", displayName: "Proxied Opus", effortLevels: [] }],
      },
    ];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(custom));

    const { resolveProviderModel } = await import("@/server/providers");
    const result = resolveProviderModel("claude-opus-4-7");

    expect(result!.provider.id).toBe("anthropic");
  });

  it("resolveProviderModel supports qualified providerId:modelId form", async () => {
    const fs = await import("node:fs");
    const custom = [
      {
        id: "proxy-1",
        name: "My Proxy",
        envVars: { ANTHROPIC_BASE_URL: "http://localhost:8080" },
        models: [{ modelId: "claude-opus-4-7", displayName: "Proxied Opus", effortLevels: [] }],
      },
    ];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(custom));

    const { resolveProviderModel } = await import("@/server/providers");
    const result = resolveProviderModel("proxy-1:claude-opus-4-7");

    expect(result).not.toBeNull();
    expect(result!.provider.id).toBe("proxy-1");
  });

  it("addProvider generates UUID and persists", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => "");

    const { addProvider } = await import("@/server/providers");
    const provider = addProvider({
      name: "Test",
      envVars: {},
      models: [],
    });

    expect(provider.id).toBeTruthy();
    expect(provider.name).toBe("Test");
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it("deleteProvider throws for built-in provider", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { deleteProvider } = await import("@/server/providers");
    expect(() => deleteProvider("anthropic")).toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/providers.test.ts`
Expected: FAIL (module does not exist yet)

- [ ] **Step 4: Implement `src/server/providers.ts`**

```typescript
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { toProviderModels } from "@/lib/models";
import type { Provider, ProviderModel } from "@/types";

const PREFS_DIR = join(homedir(), ".cockpit");
const PROVIDERS_FILE = join(PREFS_DIR, "providers.json");

function buildAnthropicProvider(): Provider {
  return {
    id: "anthropic",
    name: "Anthropic",
    envVars: {},
    models: toProviderModels(),
    isBuiltin: true,
  };
}

let cache: Provider[] | null = null;

function loadCustom(): Provider[] {
  try {
    return JSON.parse(readFileSync(PROVIDERS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveCustom(providers: Provider[]): void {
  try {
    mkdirSync(PREFS_DIR, { recursive: true });
    writeFileSync(PROVIDERS_FILE, JSON.stringify(providers, null, 2) + "\n");
  } catch {
    // best effort
  }
}

export function getProviders(): Provider[] {
  if (!cache) {
    cache = [buildAnthropicProvider(), ...loadCustom()];
  }
  return cache;
}

export function getProvider(id: string): Provider | undefined {
  return getProviders().find((p) => p.id === id);
}

export function addProvider(provider: Omit<Provider, "id">): Provider {
  const newProvider: Provider = { ...provider, id: uuidv4() };
  const all = getProviders();
  const custom = all.filter((p) => !p.isBuiltin);
  custom.push(newProvider);
  saveCustom(custom);
  cache = [buildAnthropicProvider(), ...custom];
  return newProvider;
}

export function updateProvider(id: string, partial: Partial<Provider>): Provider {
  if (id === "anthropic") throw new Error("Cannot modify built-in provider");
  const all = getProviders();
  const custom = all.filter((p) => !p.isBuiltin);
  const idx = custom.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Provider not found: ${id}`);
  custom[idx] = { ...custom[idx], ...partial, id };
  saveCustom(custom);
  cache = [buildAnthropicProvider(), ...custom];
  return custom[idx];
}

export function deleteProvider(id: string): void {
  if (id === "anthropic") throw new Error("Cannot delete built-in provider");
  const all = getProviders();
  const custom = all.filter((p) => !p.isBuiltin && p.id !== id);
  if (custom.length === all.filter((p) => !p.isBuiltin).length) {
    throw new Error(`Provider not found: ${id}`);
  }
  saveCustom(custom);
  cache = [buildAnthropicProvider(), ...custom];
}

export function setProviders(providers: Provider[]): void {
  const custom = providers.filter((p) => !p.isBuiltin);
  saveCustom(custom);
  cache = [buildAnthropicProvider(), ...custom];
}

export function resolveProviderModel(modelId: string): { provider: Provider; model: ProviderModel } | null {
  if (!modelId) return null;

  const colon = modelId.indexOf(":");
  if (colon > 0) {
    const providerId = modelId.slice(0, colon);
    const bareModel = modelId.slice(colon + 1);
    const provider = getProvider(providerId);
    if (provider) {
      const model = provider.models.find((m) => m.modelId === bareModel);
      if (model) return { provider, model };
    }
    return null;
  }

  for (const provider of getProviders()) {
    const model = provider.models.find((m) => m.modelId === modelId);
    if (model) return { provider, model };
  }
  return null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/providers.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/models.ts src/server/providers.ts tests/providers.test.ts
git commit -m "feat: add provider storage and resolveProviderModel lookup"
```

---

### Task 3: Provider API routes

**Files:**
- Create: `src/app/api/providers/route.ts`
- Create: `src/app/api/providers/[id]/route.ts`

- [ ] **Step 1: Create list/create endpoint**

Create `src/app/api/providers/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { addProvider, getProviders } from "@/server/providers";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

export function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(getProviders());
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!body.name || !body.models) {
    return NextResponse.json({ error: "name and models are required" }, { status: 400 });
  }
  const provider = addProvider({
    name: body.name,
    envVars: body.envVars || {},
    models: body.models || [],
  });
  return NextResponse.json(provider, { status: 201 });
}
```

- [ ] **Step 2: Create update/delete endpoint**

Create `src/app/api/providers/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { deleteProvider, getProvider, updateProvider } from "@/server/providers";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const existing = getProvider(id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const body = await req.json();
    const updated = updateProvider(id, body);
    return NextResponse.json(updated);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Update failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkAuth(_req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    deleteProvider(id);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Delete failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/providers/route.ts src/app/api/providers/\[id\]/route.ts
git commit -m "feat: add provider CRUD API routes"
```

---

### Task 4: Defaults migration to modelSlots

**Files:**
- Modify: `src/server/defaults.ts`
- Modify: `src/hooks/use-settings.ts`
- Modify: `tests/defaults.test.ts`

- [ ] **Step 1: Update defaults.test.ts for modelSlots**

In `tests/defaults.test.ts`, update the fallback expectation (line 25-37):

Change `model: "sonnet"` to `modelSlots: { main: "sonnet" }` in the expected output of the "returns fallback" test.

Update the "merges file contents" test: the mock data has `model: "opus"`. After migration, `getDefaults()` should return `modelSlots: { main: "opus" }` (the migration converts old `model` field).

Add a new test:

```typescript
it("migrates legacy model field to modelSlots on read", async () => {
  const fs = await import("node:fs");
  vi.mocked(fs.readFileSync).mockReturnValue(
    JSON.stringify({ model: "opus" }),
  );

  const { getDefaults } = await import("@/server/defaults");
  const defaults = getDefaults();

  expect(defaults.modelSlots).toEqual({ main: "opus" });
  expect((defaults as Record<string, unknown>).model).toBeUndefined();
});

it("preserves modelSlots when already present", async () => {
  const fs = await import("node:fs");
  vi.mocked(fs.readFileSync).mockReturnValue(
    JSON.stringify({ modelSlots: { main: "opus", subagent: "haiku" } }),
  );

  const { getDefaults } = await import("@/server/defaults");
  const defaults = getDefaults();

  expect(defaults.modelSlots).toEqual({ main: "opus", subagent: "haiku" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/defaults.test.ts`
Expected: FAIL (AppDefaults still has `model: string`)

- [ ] **Step 3: Update `src/server/defaults.ts`**

Replace the `model: string` field in `AppDefaults` with `modelSlots`:

```typescript
import type { ModelSlots, ThinkingLevel } from "@/types";

export interface AppDefaults {
  thinkingLevel: ThinkingLevel;
  bypassAllPermissions: boolean;
  diffStyle: DiffStyle;
  dismissKeyboardOnSend: boolean;
  thinkingExpanded: boolean;
  readExpanded: boolean;
  editExpanded: boolean;
  toolCallsExpanded: boolean;
  modelSlots: ModelSlots;
  messageStitching: boolean;
  reviewsEnabled: boolean;
}

const fallback: AppDefaults = {
  thinkingLevel: "high",
  bypassAllPermissions: false,
  diffStyle: "split",
  dismissKeyboardOnSend: true,
  thinkingExpanded: false,
  readExpanded: false,
  editExpanded: false,
  toolCallsExpanded: false,
  modelSlots: { main: "sonnet" },
  messageStitching: true,
  reviewsEnabled: true,
};
```

Update `getDefaults()` to migrate the old `model` field:

```typescript
export function getDefaults(): AppDefaults {
  try {
    const raw = JSON.parse(readFileSync(DEFAULTS_FILE, "utf-8"));
    if (raw.model && !raw.modelSlots) {
      raw.modelSlots = { main: raw.model };
      delete raw.model;
    }
    return { ...fallback, ...raw };
  } catch {
    return { ...fallback };
  }
}
```

- [ ] **Step 4: Update `src/hooks/use-settings.ts`**

Replace `model: string` with `modelSlots: ModelSlots` in the `Settings` interface:

```typescript
import type { ModelSlots } from "@/types";

export interface Settings {
  diffStyle: DiffStyle;
  dismissKeyboardOnSend: boolean;
  thinkingLevel: ThinkingLevel;
  bypassAllPermissions: boolean;
  thinkingExpanded: boolean;
  readExpanded: boolean;
  editExpanded: boolean;
  toolCallsExpanded: boolean;
  modelSlots: ModelSlots;
  messageStitching: boolean;
  reviewsEnabled: boolean;
}

const defaultSettings: Settings = {
  diffStyle: "split",
  dismissKeyboardOnSend: true,
  thinkingLevel: "high",
  bypassAllPermissions: false,
  thinkingExpanded: false,
  readExpanded: false,
  editExpanded: false,
  toolCallsExpanded: false,
  modelSlots: { main: "sonnet" },
  messageStitching: true,
  reviewsEnabled: true,
};
```

The `useSettings()` hook also needs migration logic in its `useEffect` fetch handler. After receiving data from `/api/defaults`, if the response has `model` instead of `modelSlots`, convert it:

```typescript
useEffect(() => {
  fetch("/api/defaults")
    .then((res) => res.json())
    .then((data) => {
      if (data.model && !data.modelSlots) {
        data.modelSlots = { main: data.model };
        delete data.model;
      }
      setSettings({ ...defaultSettings, ...data });
      setLoaded(true);
    })
    .catch(() => setLoaded(true));
}, []);
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/defaults.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/defaults.ts src/hooks/use-settings.ts tests/defaults.test.ts
git commit -m "feat: migrate defaults from model string to modelSlots"
```

---

### Task 5: Session prefs and session manager modelSlots

**Files:**
- Modify: `src/server/session-prefs.ts`
- Modify: `src/server/session-manager.ts`

- [ ] **Step 1: Add modelSlots to SessionPrefs**

In `src/server/session-prefs.ts`, add the import and field:

```typescript
import type { InitData, ModelSlots, ThinkingLevel } from "@/types";

export interface SessionPrefs {
  name?: string;
  thinkingLevel?: ThinkingLevel;
  bypassAllPermissions?: boolean;
  planMode?: boolean;
  model?: string;
  modelSlots?: ModelSlots;
  initData?: InitData;
  cliSessionId?: string;
  previousCliSessionIds?: string[];
  openTabs?: PersistedTab[];
  activeTabId?: string;
}
```

- [ ] **Step 2: Update session-manager.ts imports**

Add the providers import and update model imports at the top of `src/server/session-manager.ts`:

```typescript
import { allowedEffortLevels, coerceEffort, recommendedEffort, resolveModel } from "@/lib/models";
import { resolveProviderModel } from "@/server/providers";
```

Add `ModelSlots` to the types import:

```typescript
import type {
  ChatMessage,
  ContentBlock,
  ContextUsage,
  DocumentAttachment,
  ImageAttachment,
  InitData,
  ModelSlots,
  SessionInfo,
  ThinkingLevel,
  TodoItem,
  ToolUse,
} from "@/types";
```

- [ ] **Step 3: Add modelSlots to Session interface**

Find the internal `Session` interface in `session-manager.ts` (around line 60-80). Add `modelSlots: ModelSlots` field. In `createSession()` (where sessions are constructed), initialize it from session prefs:

```typescript
const prefs = getSessionPrefs(sessionId);
const modelSlots: ModelSlots = prefs?.modelSlots ?? (prefs?.model ? { main: prefs.model } : { main: defaults.modelSlots.main ?? "sonnet" });
```

Store `modelSlots` on the session object. Set `session.info.model` from `modelSlots.main` for backward compat with the UI.

- [ ] **Step 4: Update `spawnProcess()` to inject provider env vars**

In `spawnProcess()` (line 1597-1607), after building the base env, look up the main model's provider and merge its env vars:

```typescript
const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;

const resolved = resolveProviderModel(session.modelSlots.main ?? session.info.model ?? "sonnet");
if (resolved) {
  Object.assign(env, resolved.provider.envVars);
  if (resolved.model.supportsExtendedContext === false || !session.info.model?.includes("[1m]")) {
    env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
  }
}

if (session.modelSlots.subagent && session.modelSlots.subagent !== session.modelSlots.main) {
  env.ANTHROPIC_SMALL_FAST_MODEL = session.modelSlots.subagent;
}
```

- [ ] **Step 5: Add `setModelSlot()` method**

Add a new method alongside the existing `setModel()`:

```typescript
setModelSlot(sessionId: string, slot: "main" | "subagent" | "fast", modelId: string): void {
  const session = this.sessions.get(sessionId);
  if (!session) return;

  const slots = { ...session.modelSlots };
  slots[slot] = modelId;
  session.modelSlots = slots;
  setSessionPrefs(sessionId, { modelSlots: slots });

  if (slot === "main") {
    this.setModel(sessionId, modelId);
  } else {
    this.killProcess(session);
    session.queuedMessages.length = 0;
    session.queuePaused = false;
    session.info.status = "idle";
    session.emitter.emit("status", sessionId, "idle");
    this.emitInfoUpdated(session, sessionId);
  }
}
```

This delegates main slot changes to the existing `setModel()` logic (which handles control_request vs respawn). Subagent/fast always respawn since they require env var changes.

- [ ] **Step 6: Commit**

```bash
git add src/server/session-prefs.ts src/server/session-manager.ts
git commit -m "feat: add modelSlots to session manager with provider env var injection"
```

---

### Task 6: WebSocket protocol update

**Files:**
- Modify: `src/server/ws-handler.ts`
- Modify: `src/hooks/use-session.ts`

- [ ] **Step 1: Add `session:set_model_slot` handler in ws-handler.ts**

In `src/server/ws-handler.ts`, find the `session:set_model` case (line 591). Add a new case after it:

```typescript
case "session:set_model_slot": {
  sessionManager.setModelSlot(msg.sessionId, msg.slot, msg.modelId);
  break;
}
```

Keep the old `session:set_model` case for backward compatibility.

- [ ] **Step 2: Update `use-session.ts` to expose `setModelSlot`**

In `src/hooks/use-session.ts`, add `setModelSlot` alongside the existing `setModel`:

```typescript
const setModelSlot = useCallback(
  (slot: "main" | "subagent" | "fast", modelId: string) => {
    if (slot === "main") setCurrentModel(modelId);
    send({ type: "session:set_model_slot", sessionId, slot, modelId });
  },
  [send, sessionId],
);
```

Add `setModelSlot` to the `UseSessionReturn` interface and the return object.

The caller (ChatView or ModelPicker) should show a confirmation dialog before calling `setModelSlot` when the new model belongs to a different provider than the current one (different env vars means respawn). Use `window.confirm()` or the existing dialog pattern in the codebase. The message should warn that switching providers resets the conversation context.

- [ ] **Step 3: Commit**

```bash
git add src/server/ws-handler.ts src/hooks/use-session.ts
git commit -m "feat: add session:set_model_slot WebSocket message"
```

---

### Task 7: Update model picker for multi-provider

**Files:**
- Modify: `src/components/model-picker.tsx`

- [ ] **Step 1: Rewrite model-picker.tsx to support providers**

The model picker needs to fetch providers and display models grouped by provider. Replace `buildRows()` (which reads from hardcoded `MODELS`) with a provider-aware version.

Add a `providers` prop or fetch providers client-side. Since the model picker is rendered inside `ChatView`, pass providers as a prop from the parent (fetched via `GET /api/providers`).

Update the `ModelPickerProps` interface:

```typescript
import type { Provider, ProviderModel } from "@/types";

interface ModelPickerProps {
  currentModel: string;
  activeModelId: string | null;
  onSelect: (model: string) => void;
  providers: Provider[];
  slot?: "main" | "subagent" | "fast";
}
```

Build rows from providers instead of the hardcoded MODELS array:

```typescript
interface PickerRow {
  key: string;
  value: string;
  label: string;
  description: string;
  providerId: string;
  providerName: string;
  extended: boolean;
  effortLevels: ThinkingLevel[];
}

function buildRows(providers: Provider[]): PickerRow[] {
  const rows: PickerRow[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      rows.push({
        key: `${provider.id}:${model.modelId}`,
        value: model.modelId,
        label: model.displayName,
        description: model.effortLevels.length > 0 ? `Thinking: ${model.effortLevels.join(", ")}` : "No thinking",
        providerId: provider.id,
        providerName: provider.name,
        extended: false,
        effortLevels: model.effortLevels,
      });
      if (model.supportsExtendedContext) {
        rows.push({
          key: `${provider.id}:${model.modelId}[1m]`,
          value: `${model.modelId}[1m]`,
          label: `${model.displayName} (1M)`,
          description: model.effortLevels.length > 0 ? `Thinking: ${model.effortLevels.join(", ")}` : "No thinking",
          providerId: provider.id,
          providerName: provider.name,
          extended: true,
          effortLevels: model.effortLevels,
        });
      }
    }
  }
  return rows;
}
```

Render with provider group headings:

```typescript
export function ModelPicker({ currentModel, activeModelId, onSelect, providers, slot }: ModelPickerProps) {
  const rows = buildRows(providers);
  const currentBase = baseAlias(currentModel);
  const currentExtended = hasExtendedContext(currentModel);

  let lastProvider = "";

  return (
    <div className="mx-auto max-w-3xl">
      <div className="rounded-lg border border-border bg-card p-4 space-y-1">
        <div className="flex items-baseline justify-between pb-2">
          <div className="text-sm font-medium">
            {slot ? `Switch ${slot} model` : "Switch model"}
          </div>
          <div className="text-xs text-muted-foreground font-mono">
            Current: {currentModel}
          </div>
        </div>
        {rows.map((row) => {
          const showHeader = row.providerName !== lastProvider;
          lastProvider = row.providerName;
          const active = row.value === currentBase && row.extended === currentExtended;
          return (
            <div key={row.key}>
              {showHeader && (
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider pt-3 pb-1 px-3">
                  {row.providerName}
                </div>
              )}
              <button
                onClick={() => onSelect(row.value)}
                className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  active ? "bg-primary/10 text-primary" : "hover:bg-muted text-foreground"
                }`}
              >
                <div className="w-4 shrink-0">{active && <Check className="h-4 w-4" />}</div>
                <span className="font-mono font-bold">{row.value}</span>
                <span className="text-muted-foreground">{row.label}</span>
                <span className="text-muted-foreground ml-auto text-xs">{row.description}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update ChatView to pass providers to ModelPicker**

In `src/components/chat-view.tsx`, find where `<ModelPicker>` is rendered. Add provider fetching (useState + useEffect that calls `GET /api/providers`) and pass the result as a prop.

- [ ] **Step 3: Commit**

```bash
git add src/components/model-picker.tsx src/components/chat-view.tsx
git commit -m "feat: update model picker to show models grouped by provider"
```

---

### Task 8: Update input-area effort levels

**Files:**
- Modify: `src/components/input-area.tsx`

- [ ] **Step 1: Replace `allowedEffortLevels` with provider-based lookup**

In `src/components/input-area.tsx` (line 838), the thinking level selector uses `allowedEffortLevels(parsed.entry)` where `parsed.entry` is a `ModelEntry` from the hardcoded list.

The input area needs access to the provider model's `effortLevels`. Two options:
1. Pass effort levels as a prop from ChatView
2. Have the input area fetch providers

Option 1 is cleaner. Add an `effortLevels: ThinkingLevel[]` prop to the input area component. ChatView computes this by looking up the current model via an API call or cached provider list.

In `input-area.tsx`, replace:
```typescript
const allowed = new Set(allowedEffortLevels(parsed.entry));
```
with:
```typescript
const allowed = new Set(effortLevels);
```

where `effortLevels` is the prop passed from the parent.

For the model rows inside the input area's inline model picker (if it has one), those still need the full provider list. Pass `providers: Provider[]` as a prop alongside `effortLevels`.

- [ ] **Step 2: Update ChatView to pass effort levels**

In `src/components/chat-view.tsx`, compute `effortLevels` from the cached providers list and current model, then pass to `<InputArea>`.

- [ ] **Step 3: Commit**

```bash
git add src/components/input-area.tsx src/components/chat-view.tsx
git commit -m "feat: use provider-based effort levels in input area"
```

---

### Task 9: Update settings page

**Files:**
- Modify: `src/app/(app)/settings/page.tsx`

- [ ] **Step 1: Update model defaults section to use modelSlots**

The settings page currently has a model selector that sets `settings.model`. Update it to set `settings.modelSlots.main`. The thinking level logic that calls `allowedEffortLevels(resolveModel(base))` should instead look up effort levels from `resolveProviderModel` via the providers API.

Fetch providers in the settings page via `GET /api/providers` (useEffect + useState). Use the provider list to build model options and derive effort levels.

Replace references to `settings.model` with `settings.modelSlots.main`. Replace `updateSetting("model", value)` with `updateSetting("modelSlots", { ...settings.modelSlots, main: value })`.

- [ ] **Step 2: Add provider management UI**

Add a "Providers" card to the settings page with:

- List of providers (fetched from `GET /api/providers`)
- Each provider row: name, model count, expand/collapse
- Expanded view: env var list, model list
- "Add Provider" button that opens an inline form
- Provider form fields:
  - Name: text input
  - Env vars: key-value list with add/remove buttons
  - Models: list with add/remove, each model has modelId, displayName, effort checkboxes, extended context toggle
- Save button calls `POST /api/providers` (new) or `PUT /api/providers/[id]` (edit)
- Delete button calls `DELETE /api/providers/[id]` (hidden for Anthropic)

This is the largest UI task. The provider form should be a separate component within the settings page to keep the file manageable. Consider extracting it to `src/components/provider-form.tsx` if the settings page is already large.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(app\)/settings/page.tsx src/components/provider-form.tsx
git commit -m "feat: add provider management UI to settings page"
```

---

### Task 10: Update job editor

**Files:**
- Modify: `src/app/(app)/jobs/[id]/edit/page.tsx`

- [ ] **Step 1: Replace hardcoded model list with provider-based list**

The job editor currently uses `findModelById`, `versionsForAlias`, `allowedEffortLevels`, etc. from `models.ts`. Update it to:

1. Fetch providers via `GET /api/providers` (useEffect + useState)
2. Build model options from all providers
3. Replace `allowedEffortLevels(selectedEntry)` with the model's `effortLevels` from the provider lookup
4. Replace `resolveModel(baseModel)` with a client-side search through the providers list

The job's saved `model` field maps to the main slot. Future extension can add subagent/fast slot config to the job form.

- [ ] **Step 2: Commit**

```bash
git add src/app/\(app\)/jobs/\[id\]/edit/page.tsx
git commit -m "feat: use provider model list in job editor"
```

---

### Task 11: Type check and final verification

- [ ] **Step 1: Run type checker**

Run: `npx tsc --noEmit`

Fix any type errors. Common issues to expect:
- Places that reference `settings.model` need updating to `settings.modelSlots.main`
- Places that import `model` from `AppDefaults` need the new shape
- `ModelPicker` callers need to pass `providers` prop

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`

Fix any failing tests. Expect failures in:
- `tests/defaults.test.ts` (if migration logic has edge cases)
- `tests/session-manager.test.ts` (if it references `setModel` directly)
- `tests/ws-handler.test.ts` (if it sends `session:set_model` messages)

- [ ] **Step 3: Format**

Run: `npx biome format --write src/ tests/`

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "fix: resolve type errors and test failures for multi-provider support"
```
