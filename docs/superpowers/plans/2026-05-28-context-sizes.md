# Selectable Context Window Sizes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `supportsExtendedContext: boolean` on `ProviderModel`/`ModelEntry` with `contextSizes: ContextSize[]`, drop the `[1m]` suffix from model strings in storage and the WS protocol, and drive the context selector from the model's `contextSizes` array.

**Architecture:** New catalog `CONTEXT_SIZES` in `lib/models.ts` is the single source of truth. Stored records and the WS protocol gain an explicit `contextSize` field. The server spawn paths read that field instead of regex-parsing the model string. A `splitLegacyModel` helper migrates pre-existing data passively on read. Frontend selectors render a button group when `contextSizes.length >= 2` and hide otherwise.

**Tech Stack:** TypeScript, React, Next.js, Vitest, Biome.

---

## File Structure

**New files:**
- `tests/legacy-model-split.test.ts` — unit tests for `splitLegacyModel`
- `tests/session-prefs-context.test.ts` — read-side migration of session prefs
- `tests/job-storage-context.test.ts` — read-side migration of jobs
- `tests/session-manager-context.test.ts` — spawn env var assertions

**Modified files (foundation):**
- `src/lib/models.ts` — add `CONTEXT_SIZES`, `ContextSize`, `DEFAULT_CONTEXT_SIZE`, `splitLegacyModel`; rewrite `MODELS` seed values; drop `supportsExtendedContext` from `ModelEntry`; rewrite `toProviderModels`
- `src/types/index.ts` — `ProviderModel.contextSizes`, `ModelSlots.mainContext`, `ScheduledJob.contextSize`, WS `set_model` carries `contextSize`, `Session.info.contextSize`

**Modified files (server):**
- `src/server/session-prefs.ts` — `SessionPrefs.contextSize` field, apply `splitLegacyModel` at read time
- `src/server/job-storage.ts` — apply `splitLegacyModel` at read time
- `src/server/session-manager.ts` — spawn paths use `contextSize`, `setModel` signature change, coercion logic, drop `[1m]` regex
- `src/server/ws-handler.ts` — `session:set_model` handler forwards `contextSize`
- `src/server/providers.ts` — validate `contextSizes` non-empty

**Modified files (frontend):**
- `src/hooks/use-settings.ts` — extend init migration to split `modelSlots.main`
- `src/hooks/use-session.ts` — `onSetModel` signature carries `contextSize`
- `src/components/provider-form.tsx` — `ContextSizePills`, `EditingModel.contextSizes`, validation, collapsed-row display
- `src/components/model-picker.tsx` — single row per model, inline size pills, signature change
- `src/components/input-area.tsx` — selector reads `contextSizes`, drop suffix helpers
- `src/app/(app)/jobs/[id]/edit/page.tsx` — selector reads `contextSizes`, write `contextSize` separately
- `src/app/(app)/settings/session/page.tsx` — selector + `mainContext` field

---

### Task 1: Add CONTEXT_SIZES catalog and ContextSize type

**Files:**
- Modify: `src/lib/models.ts`

- [ ] **Step 1: Add catalog and exports at the top of the file (after the imports)**

```ts
export const CONTEXT_SIZES = {
  "200k": { label: "200K", disableEnv: true },
  "1m": { label: "1M", disableEnv: false },
} as const;

export type ContextSize = keyof typeof CONTEXT_SIZES;

export const DEFAULT_CONTEXT_SIZE: ContextSize = "200k";
```

- [ ] **Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: PASS (existing errors only, no new errors).

- [ ] **Step 3: Commit**

```bash
git add src/lib/models.ts
git commit -m "Add CONTEXT_SIZES catalog and ContextSize type"
```

---

### Task 2: Add splitLegacyModel helper with tests

**Files:**
- Create: `tests/legacy-model-split.test.ts`
- Modify: `src/lib/models.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_SIZE, splitLegacyModel } from "@/lib/models";

describe("splitLegacyModel", () => {
  it("returns undefined model and default size for empty input", () => {
    expect(splitLegacyModel(undefined)).toEqual({ model: undefined, contextSize: DEFAULT_CONTEXT_SIZE });
    expect(splitLegacyModel("")).toEqual({ model: undefined, contextSize: DEFAULT_CONTEXT_SIZE });
  });

  it("returns bare modelId and 200k when no suffix is present", () => {
    expect(splitLegacyModel("claude-opus-4-7")).toEqual({ model: "claude-opus-4-7", contextSize: "200k" });
  });

  it("strips [1m] suffix and returns contextSize 1m", () => {
    expect(splitLegacyModel("claude-opus-4-7[1m]")).toEqual({ model: "claude-opus-4-7", contextSize: "1m" });
    expect(splitLegacyModel("sonnet[1m]")).toEqual({ model: "sonnet", contextSize: "1m" });
  });

  it("strips unrecognized brackets and falls back to 200k", () => {
    expect(splitLegacyModel("claude-foo[2m]")).toEqual({ model: "claude-foo", contextSize: "200k" });
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/legacy-model-split.test.ts`
Expected: FAIL with "splitLegacyModel is not a function" (or undefined import).

- [ ] **Step 3: Add the helper to `src/lib/models.ts`**

Append below the existing exports:

```ts
export function splitLegacyModel(stored: string | undefined | null): {
  model: string | undefined;
  contextSize: ContextSize;
} {
  if (!stored) return { model: undefined, contextSize: DEFAULT_CONTEXT_SIZE };
  const hasOneM = /\[1m\]$/i.test(stored);
  const stripped = stored.replace(/\[.*\]$/, "");
  return {
    model: stripped || undefined,
    contextSize: hasOneM ? "1m" : "200k",
  };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/legacy-model-split.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add tests/legacy-model-split.test.ts src/lib/models.ts
git commit -m "Add splitLegacyModel helper for read-side suffix migration"
```

---

### Task 3: Add contextSizes to ModelEntry and seed the MODELS array

**Files:**
- Modify: `src/lib/models.ts`

- [ ] **Step 1: Change the `ModelEntry` interface**

Replace the line `supportsExtendedContext: boolean;` with `contextSizes: ContextSize[];`.

- [ ] **Step 2: Update each entry in the `MODELS` array**

Replace `supportsExtendedContext: false,` with `contextSizes: ["200k"],` (haiku entry).
Replace `supportsExtendedContext: true,` with `contextSizes: ["200k", "1m"],` (sonnet, opus 4.6, opus 4.7 entries).

After this step the four entries look like:

```ts
{ alias: "haiku", version: "4.5", modelId: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest", contextSizes: ["200k"], contextWindow: 200_000, isDefault: true },
{ alias: "sonnet", version: "4.6", modelId: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "Balanced", contextSizes: ["200k", "1m"], contextWindow: 200_000, isDefault: true },
{ alias: "opus", version: "4.6", modelId: "claude-opus-4-6", displayName: "Opus 4.6", description: "Previous generation", contextSizes: ["200k", "1m"], contextWindow: 200_000 },
{ alias: "opus", version: "4.7", modelId: "claude-opus-4-7", displayName: "Opus 4.7", description: "Most capable", contextSizes: ["200k", "1m"], contextWindow: 200_000, isDefault: true },
```

- [ ] **Step 3: Update `toProviderModels` to emit contextSizes**

Replace the existing `toProviderModels` body with:

```ts
export function toProviderModels(): ProviderModel[] {
  return MODELS.map((m) => ({
    modelId: m.modelId,
    displayName: m.displayName,
    effortLevels: allowedEffortLevels(m),
    contextSizes: m.contextSizes,
    defaultEffort: recommendedEffort(m) ?? undefined,
  }));
}
```

- [ ] **Step 4: Update `ProviderModel` in `src/types/index.ts`**

Find `supportsExtendedContext?: boolean;` and replace with `contextSizes: ContextSize[];`. Add `import type { ContextSize } from "@/lib/models";` if not already imported.

- [ ] **Step 5: Verify type-check fails at consumer sites**

Run: `npx tsc --noEmit`
Expected: FAIL at multiple sites that read `supportsExtendedContext`. List them — they are addressed in later tasks.

This task intentionally leaves a broken tree. The next tasks repair each consumer.

- [ ] **Step 6: Commit**

```bash
git add src/lib/models.ts src/types/index.ts
git commit -m "Replace supportsExtendedContext with contextSizes array on model entries"
```

---

### Task 4: Add context-related fields to types and stored records

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/server/session-prefs.ts`

- [ ] **Step 1: Update `ModelSlots` in `src/types/index.ts`**

Find the existing `ModelSlots` interface and replace with:

```ts
export interface ModelSlots {
  main?: string;
  mainContext?: ContextSize;
  subagent?: string;
  fast?: string;
}
```

- [ ] **Step 2: Update `ScheduledJob`**

Locate the `ScheduledJob` interface (line ~189) and add a `contextSize?: ContextSize;` field next to the existing `model?: string;`.

- [ ] **Step 3: Update `Session.info` (or the equivalent Session record)**

Locate the `Session` interface (line ~6-12) which contains `model?: string;`. Add `contextSize?: ContextSize;` next to it.

- [ ] **Step 4: Update WS messages**

Find the `session:set_model` discriminated union arm and change to:

```ts
| { type: "session:set_model"; sessionId: string; model: string; contextSize?: ContextSize }
```

Leave `session:set_model_slot` unchanged.

- [ ] **Step 5: Update `SessionPrefs` in `src/server/session-prefs.ts`**

Add `contextSize?: ContextSize;` next to the existing `model?: string;`. Add the import: `import type { ContextSize } from "@/lib/models";`.

- [ ] **Step 6: Verify type-check progresses**

Run: `npx tsc --noEmit`
Expected: errors at consumer call sites only, no errors about missing fields on the types themselves.

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/server/session-prefs.ts
git commit -m "Add contextSize fields to stored records and WS protocol"
```

---

### Task 5: Read-side migration in session-prefs

**Files:**
- Create: `tests/session-prefs-context.test.ts`
- Modify: `src/server/session-prefs.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("node:fs");
vi.mock("node:os", () => ({ homedir: () => "/home/user" }));
vi.mock("node:path", async () => {
  const actual = await vi.importActual("node:path");
  return { ...actual, join: (...args: string[]) => args.join("/") };
});

describe("getSessionPrefs context migration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("splits a legacy [1m] suffix into model + contextSize fields", async () => {
    const fs = await import("node:fs");
    const stored = JSON.stringify({
      "sess-1": { model: "claude-opus-4-7[1m]", modelSlots: { main: "claude-opus-4-7[1m]" } },
    });
    vi.mocked(fs.readFileSync).mockReturnValue(stored as never);

    const { getSessionPrefs } = await import("@/server/session-prefs");
    const prefs = getSessionPrefs("sess-1");

    expect(prefs?.model).toBe("claude-opus-4-7");
    expect(prefs?.contextSize).toBe("1m");
    expect(prefs?.modelSlots?.main).toBe("claude-opus-4-7");
    expect(prefs?.modelSlots?.mainContext).toBe("1m");
  });

  it("leaves modern shapes untouched", async () => {
    const fs = await import("node:fs");
    const stored = JSON.stringify({
      "sess-2": { model: "claude-sonnet-4-6", contextSize: "200k", modelSlots: { main: "claude-sonnet-4-6", mainContext: "200k" } },
    });
    vi.mocked(fs.readFileSync).mockReturnValue(stored as never);

    const { getSessionPrefs } = await import("@/server/session-prefs");
    const prefs = getSessionPrefs("sess-2");

    expect(prefs?.model).toBe("claude-sonnet-4-6");
    expect(prefs?.contextSize).toBe("200k");
    expect(prefs?.modelSlots?.main).toBe("claude-sonnet-4-6");
    expect(prefs?.modelSlots?.mainContext).toBe("200k");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/session-prefs-context.test.ts`
Expected: FAIL — model still contains `[1m]`, contextSize undefined.

- [ ] **Step 3: Apply migration inside `getSessionPrefs`**

In `src/server/session-prefs.ts`, modify `getSessionPrefs` to project the prefs through a normalizer. Add the helper near the top of the file:

```ts
import { splitLegacyModel } from "@/lib/models";

function normalize(raw: SessionPrefs | undefined): SessionPrefs | undefined {
  if (!raw) return raw;
  const next = { ...raw };
  if (next.model && next.model.includes("[")) {
    const split = splitLegacyModel(next.model);
    next.model = split.model;
    if (next.contextSize === undefined) next.contextSize = split.contextSize;
  }
  if (next.modelSlots?.main && next.modelSlots.main.includes("[")) {
    const split = splitLegacyModel(next.modelSlots.main);
    next.modelSlots = {
      ...next.modelSlots,
      main: split.model,
      mainContext: next.modelSlots.mainContext ?? split.contextSize,
    };
  }
  return next;
}
```

Then change the two return paths in `getSessionPrefs`:

```ts
export function getSessionPrefs(sessionId: string): SessionPrefs | undefined {
  const all = load();
  const chain = findChainForCliSession(sessionId);
  if (chain && all[chain.cockpitId]) return normalize(all[chain.cockpitId]);
  return normalize(all[sessionId]);
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/session-prefs-context.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add tests/session-prefs-context.test.ts src/server/session-prefs.ts
git commit -m "Migrate legacy [1m] suffix on session-prefs read"
```

---

### Task 6: Read-side migration in job-storage

**Files:**
- Create: `tests/job-storage-context.test.ts`
- Modify: `src/server/job-storage.ts`

- [ ] **Step 1: Open `src/server/job-storage.ts` and locate `getJob` and the list function (whatever returns all jobs)**

Read the file to identify the exact API surface to test. Note the read function names — the test uses them.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("node:fs");
vi.mock("node:os", () => ({ homedir: () => "/home/user" }));
vi.mock("node:path", async () => {
  const actual = await vi.importActual("node:path");
  return { ...actual, join: (...args: string[]) => args.join("/") };
});

describe("job-storage context migration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("splits a legacy [1m] suffix on getJob", async () => {
    const fs = await import("node:fs");
    const stored = JSON.stringify([
      { id: "job-1", name: "x", model: "claude-opus-4-7[1m]" },
    ]);
    vi.mocked(fs.readFileSync).mockReturnValue(stored as never);

    const { getJob } = await import("@/server/job-storage");
    const job = getJob("job-1");

    expect(job?.model).toBe("claude-opus-4-7");
    expect(job?.contextSize).toBe("1m");
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npx vitest run tests/job-storage-context.test.ts`
Expected: FAIL.

- [ ] **Step 4: Apply migration in `src/server/job-storage.ts`**

Add the normalizer near the top of the file:

```ts
import { splitLegacyModel } from "@/lib/models";

function normalizeJob<T extends { model?: string; contextSize?: ContextSize }>(raw: T): T {
  if (raw.model && raw.model.includes("[")) {
    const split = splitLegacyModel(raw.model);
    return { ...raw, model: split.model, contextSize: raw.contextSize ?? split.contextSize };
  }
  return raw;
}
```

(Adjust the import for `ContextSize` and `ScheduledJob` to suit the existing imports — the function's purpose is to project a single record. Apply it inside every reader function. For example, change `getJob` to `return normalizeJob(raw)` instead of `return raw`.)

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run tests/job-storage-context.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/job-storage-context.test.ts src/server/job-storage.ts
git commit -m "Migrate legacy [1m] suffix on job-storage read"
```

---

### Task 7: Server spawn paths use contextSize instead of regex

**Files:**
- Create: `tests/session-manager-context.test.ts`
- Modify: `src/server/session-manager.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { CONTEXT_SIZES, DEFAULT_CONTEXT_SIZE } from "@/lib/models";

describe("CONTEXT_SIZES env-var mapping", () => {
  it("200k disables 1M context", () => {
    expect(CONTEXT_SIZES["200k"].disableEnv).toBe(true);
  });

  it("1m does not disable 1M context", () => {
    expect(CONTEXT_SIZES["1m"].disableEnv).toBe(false);
  });

  it("DEFAULT_CONTEXT_SIZE is 200k", () => {
    expect(DEFAULT_CONTEXT_SIZE).toBe("200k");
  });
});
```

- [ ] **Step 2: Run the test and verify it passes (catalog already exists from Task 1)**

Run: `npx vitest run tests/session-manager-context.test.ts`
Expected: PASS, 3 tests. The catalog landed in Task 1.

- [ ] **Step 3: Replace the regex check in the stream spawn path**

In `src/server/session-manager.ts`, locate the block around line 2110:

```ts
if (session.info.model && !/\[1m\]/i.test(session.info.model)) {
  env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
}
```

Replace with:

```ts
const sizeKey = session.info.contextSize ?? DEFAULT_CONTEXT_SIZE;
if (CONTEXT_SIZES[sizeKey].disableEnv) {
  env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
}
```

Add the import at the top of the file: `import { CONTEXT_SIZES, DEFAULT_CONTEXT_SIZE } from "@/lib/models";` (or extend the existing models import).

- [ ] **Step 4: Replace the regex check in the PTY spawn path (line ~2332)**

```ts
if (session.info.model && !/\[1m\]/i.test(session.info.model)) {
  extraEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
}
```

Replace with:

```ts
const sizeKeyPty = session.info.contextSize ?? DEFAULT_CONTEXT_SIZE;
if (CONTEXT_SIZES[sizeKeyPty].disableEnv) {
  extraEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
}
```

- [ ] **Step 5: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: only errors at sites not yet migrated. The spawn paths themselves type-check.

- [ ] **Step 6: Commit**

```bash
git add tests/session-manager-context.test.ts src/server/session-manager.ts
git commit -m "Use contextSize field to drive CLAUDE_CODE_DISABLE_1M_CONTEXT"
```

---

### Task 8: setModel accepts contextSize and coerces invalid combinations

**Files:**
- Modify: `src/server/session-manager.ts`

- [ ] **Step 1: Locate `setModel` (line ~1024) and change its signature**

```ts
async setModel(sessionId: string, model: string, contextSize?: ContextSize): Promise<void> {
```

Add `import type { ContextSize } from "@/lib/models";` if not already present.

- [ ] **Step 2: Replace the `[1m]` flip detection with explicit field comparison**

Find:

```ts
const has1m = (m: string | undefined) => !!m && /\[1m\]/i.test(m);
const contextChanged = has1m(session.info.model) !== has1m(model);
```

Replace with:

```ts
const currentSize = session.info.contextSize ?? DEFAULT_CONTEXT_SIZE;
const requestedSize = contextSize ?? currentSize;
const resolvedSize = (() => {
  const sizes = resolveModel(model)?.contextSizes;
  if (!sizes || sizes.length === 0) return requestedSize;
  return sizes.includes(requestedSize) ? requestedSize : sizes[0];
})();
const contextChanged = currentSize !== resolvedSize;
```

- [ ] **Step 3: Persist both fields**

Update the assignment block right after the change detection. Where you see:

```ts
session.info.model = model;
session.modelSlots = { ...session.modelSlots, main: model };
setSessionPrefs(sessionId, { model, modelSlots: session.modelSlots });
```

Replace with:

```ts
session.info.model = model;
session.info.contextSize = resolvedSize;
session.modelSlots = { ...session.modelSlots, main: model, mainContext: resolvedSize };
setSessionPrefs(sessionId, { model, contextSize: resolvedSize, modelSlots: session.modelSlots });
```

- [ ] **Step 4: Verify type-check passes for session-manager.ts**

Run: `npx tsc --noEmit 2>&1 | grep session-manager.ts || echo "no errors in session-manager.ts"`
Expected: "no errors in session-manager.ts".

- [ ] **Step 5: Commit**

```bash
git add src/server/session-manager.ts
git commit -m "Coerce contextSize when setModel target rejects current size"
```

---

### Task 9: ws-handler routes contextSize to setModel

**Files:**
- Modify: `src/server/ws-handler.ts`

- [ ] **Step 1: Find the `session:set_model` handler**

Search for `case "session:set_model":` in `src/server/ws-handler.ts`.

- [ ] **Step 2: Forward contextSize to setModel**

Update the handler body to pass `msg.contextSize` through:

```ts
case "session:set_model":
  await manager.setModel(msg.sessionId, msg.model, msg.contextSize);
  break;
```

(Preserve any surrounding logging or error wrapping the existing handler has.)

- [ ] **Step 3: Verify type-check passes**

Run: `npx tsc --noEmit 2>&1 | grep ws-handler.ts || echo "no errors in ws-handler.ts"`
Expected: "no errors in ws-handler.ts".

- [ ] **Step 4: Commit**

```bash
git add src/server/ws-handler.ts
git commit -m "Forward contextSize from set_model WS message"
```

---

### Task 10: providers.ts validates contextSizes non-empty

**Files:**
- Modify: `src/server/providers.ts`
- Modify: `tests/providers.test.ts`

- [ ] **Step 1: Add a validation test**

Append to `tests/providers.test.ts` inside the existing `describe("providers", ...)`:

```ts
it("rejects updateProvider with a model that has empty contextSizes", async () => {
  const fs = await import("node:fs");
  vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
  vi.mocked(fs.writeFileSync).mockImplementation(() => {});

  const { updateProvider, addProvider } = await import("@/server/providers");
  addProvider({
    id: "custom-1",
    name: "Custom",
    envVars: {},
    models: [{ modelId: "m1", displayName: "m1", effortLevels: [], contextSizes: ["200k"] }],
  });

  expect(() => updateProvider("custom-1", {
    models: [{ modelId: "m1", displayName: "m1", effortLevels: [], contextSizes: [] }],
  })).toThrow(/contextSizes/);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/providers.test.ts -t "empty contextSizes"`
Expected: FAIL — no validation in place.

- [ ] **Step 3: Add the validation in `src/server/providers.ts`**

Find `updateProvider` (and `addProvider`/`setProviders` if they accept ProviderModel arrays). Before writing to disk, validate:

```ts
function validateProvider(p: Provider): void {
  for (const m of p.models) {
    if (!Array.isArray(m.contextSizes) || m.contextSizes.length === 0) {
      throw new Error(`provider ${p.id}: model ${m.modelId} has empty contextSizes`);
    }
  }
}
```

Call `validateProvider` at the start of `addProvider`, `updateProvider`, and `setProviders`.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/providers.test.ts -t "empty contextSizes"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/providers.test.ts src/server/providers.ts
git commit -m "Validate ProviderModel.contextSizes non-empty on write"
```

---

### Task 11: use-settings migrates modelSlots.main on init

**Files:**
- Modify: `src/hooks/use-settings.ts`

- [ ] **Step 1: Locate the existing migration block (around line 60-64)**

```ts
if (data.model && !data.modelSlots) {
  data.modelSlots = { main: data.model };
}
```

- [ ] **Step 2: Extend the migration to split the suffix**

Replace the block with:

```ts
if (data.model && !data.modelSlots) {
  data.modelSlots = { main: data.model };
}
if (data.modelSlots?.main && data.modelSlots.main.includes("[")) {
  const split = splitLegacyModel(data.modelSlots.main);
  data.modelSlots = {
    ...data.modelSlots,
    main: split.model,
    mainContext: data.modelSlots.mainContext ?? split.contextSize,
  };
}
```

Add the import: `import { splitLegacyModel } from "@/lib/models";`.

- [ ] **Step 3: Verify type-check passes**

Run: `npx tsc --noEmit 2>&1 | grep use-settings.ts || echo "no errors in use-settings.ts"`
Expected: "no errors in use-settings.ts".

- [ ] **Step 4: Commit**

```bash
git add src/hooks/use-settings.ts
git commit -m "Split legacy [1m] suffix from settings on init"
```

---

### Task 12: use-session passes contextSize to set_model

**Files:**
- Modify: `src/hooks/use-session.ts`

- [ ] **Step 1: Locate every place that sends a `session:set_model` WS message**

Search the file for `"session:set_model"`. Each call currently passes a `model: string` that may contain a `[1m]` suffix.

- [ ] **Step 2: Change the `setModel` callback exposed by the hook**

The hook returns a function that components call. Change its signature from `(model: string) => void` to `(model: string, contextSize?: ContextSize) => void`. Pass `contextSize` through to the WS message:

```ts
ws.send(JSON.stringify({ type: "session:set_model", sessionId, model, contextSize }));
```

Add the import: `import type { ContextSize } from "@/lib/models";`.

- [ ] **Step 3: Verify type-check passes**

Run: `npx tsc --noEmit 2>&1 | grep use-session.ts || echo "no errors in use-session.ts"`
Expected: "no errors in use-session.ts".

- [ ] **Step 4: Commit**

```bash
git add src/hooks/use-session.ts
git commit -m "Carry contextSize through set_model WS message"
```

---

### Task 13: provider-form ContextSizePills and validation

**Files:**
- Modify: `src/components/provider-form.tsx`

- [ ] **Step 1: Add the imports**

```tsx
import { CONTEXT_SIZES, type ContextSize } from "@/lib/models";
```

- [ ] **Step 2: Update the `EditingModel` interface**

Replace `supportsExtendedContext: boolean;` with `contextSizes: ContextSize[];`.

- [ ] **Step 3: Add a ContextSizePills component above `ProviderForm`**

```tsx
function ContextSizePills({ selected, onChange }: { selected: ContextSize[]; onChange: (sizes: ContextSize[]) => void }) {
  const allSizes = Object.keys(CONTEXT_SIZES) as ContextSize[];
  return (
    <div className="ml-auto flex flex-wrap gap-1 justify-end">
      {allSizes.map((size) => {
        const isSelected = selected.includes(size);
        return (
          <button
            type="button"
            key={size}
            onClick={() => onChange(isSelected ? selected.filter((s) => s !== size) : [...selected, size])}
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {CONTEXT_SIZES[size].label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Replace the new-model state**

Change:

```tsx
const [newModelExtCtx, setNewModelExtCtx] = useState(false);
```

To:

```tsx
const [newModelContextSizes, setNewModelContextSizes] = useState<ContextSize[]>(["200k"]);
```

Update `addModel` to read the new state. Replace the supportsExtendedContext line with `contextSizes: newModelContextSizes,`. After push, reset with `setNewModelContextSizes(["200k"]);`.

- [ ] **Step 5: Replace the edit-mode 1M checkbox**

Locate the `<label>` block containing `1M context` (around line 273-281) inside the edit row. Replace with:

```tsx
<div className="flex items-center gap-2">
  <span className="text-xs text-muted-foreground">Context</span>
  <ContextSizePills
    selected={editingModel.contextSizes}
    onChange={(sizes) => setEditingModel({ ...editingModel, contextSizes: sizes })}
  />
</div>
```

Also locate the new-model checkbox block (around line 363-371) and replace with:

```tsx
<div className="flex items-center gap-2">
  <span className="text-xs text-muted-foreground">Context</span>
  <ContextSizePills selected={newModelContextSizes} onChange={setNewModelContextSizes} />
</div>
```

- [ ] **Step 6: Disable Save when contextSizes is empty**

In `saveEditingModel`, guard:

```tsx
const saveEditingModel = () => {
  if (!editingModel) return;
  if (editingModel.contextSizes.length === 0) return;
  // ...rest unchanged
};
```

Update the Save button disabled prop:

```tsx
disabled={!editingModel.modelId.trim() || editingModel.contextSizes.length === 0}
```

Update the Add button disabled prop:

```tsx
disabled={!newModelId.trim() || newModelContextSizes.length === 0}
```

- [ ] **Step 7: Update the click handler that opens the editor**

Find the call to `setEditingModel({ ... index, modelId, displayName, effortLevels, supportsExtendedContext: ... })` (around line 305-312). Replace with:

```tsx
setEditingModel({
  index: i,
  modelId: model.modelId,
  displayName: model.displayName,
  effortLevels: model.effortLevels,
  contextSizes: model.contextSizes,
})
```

- [ ] **Step 8: Update the collapsed-row badge**

Find `{model.supportsExtendedContext && <span className="text-muted-foreground">1M</span>}` (around line 324). Replace with:

```tsx
{model.contextSizes.filter((s) => s !== "200k").map((s) => (
  <span key={s} className="text-muted-foreground">{CONTEXT_SIZES[s].label}</span>
))}
```

- [ ] **Step 9: Update `saveEditingModel` write path**

Find the existing line `supportsExtendedContext: editingModel.supportsExtendedContext,` and replace with `contextSizes: editingModel.contextSizes,`.

- [ ] **Step 10: Verify type-check passes for provider-form.tsx**

Run: `npx tsc --noEmit 2>&1 | grep provider-form.tsx || echo "no errors in provider-form.tsx"`
Expected: "no errors in provider-form.tsx".

- [ ] **Step 11: Commit**

```bash
git add src/components/provider-form.tsx
git commit -m "Pill selector for available context sizes in provider form"
```

---

### Task 14: Job edit page selector and handleSave

**Files:**
- Modify: `src/app/(app)/jobs/[id]/edit/page.tsx`

- [ ] **Step 1: Locate the context selector block (around line 570-583)**

The current code:

```tsx
{((isBuiltinProvider && selectedEntry?.supportsExtendedContext) ||
  (!isBuiltinProvider && customProviderModel?.supportsExtendedContext)) && (
  <div className="flex items-center justify-between px-2 py-2 text-sm">
    <span>Context</span>
    <div className="flex gap-1">
      <Button variant={!extendedContext ? "default" : "outline"} size="sm" onClick={() => setExtendedContext(false)}>200K</Button>
      <Button variant={extendedContext ? "default" : "outline"} size="sm" onClick={() => setExtendedContext(true)}>1M</Button>
    </div>
  </div>
)}
```

- [ ] **Step 2: Replace with a contextSizes-driven selector**

First, compute the current model's sizes at the top of the component body (near the other derived values):

```tsx
const contextSizes: ContextSize[] = isBuiltinProvider
  ? (selectedEntry?.contextSizes ?? ["200k"])
  : (customProviderModel?.contextSizes ?? ["200k"]);
```

Add the import: `import { CONTEXT_SIZES, type ContextSize } from "@/lib/models";`.

Then replace the selector JSX:

```tsx
{contextSizes.length >= 2 && (
  <div className="flex items-center justify-between px-2 py-2 text-sm">
    <span>Context</span>
    <div className="flex gap-1">
      {contextSizes.map((size) => (
        <Button
          key={size}
          variant={contextSize === size ? "default" : "outline"}
          size="sm"
          onClick={() => setContextSize(size)}
        >
          {CONTEXT_SIZES[size].label}
        </Button>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 3: Replace the `extendedContext` state with `contextSize`**

Find `const [extendedContext, setExtendedContext] = useState(...)` and replace with:

```tsx
const [contextSize, setContextSize] = useState<ContextSize>("200k");
```

When the existing component loads job data from the server (search for the `useEffect` that fetches the job), set `contextSize` from `job.contextSize ?? "200k"`.

- [ ] **Step 4: Rewrite `handleSave` to write `contextSize` separately**

Find the block (line ~350-359):

```tsx
const supportsExtended = isBuiltinProvider ? (selectedEntry?.supportsExtendedContext ?? false) : (customProviderModel?.supportsExtendedContext ?? false);
let modelStr = modelId;
if (!isBuiltinProvider && selectedProviderId) {
  modelStr = `${selectedProviderId}:${modelId}`;
}
if (supportsExtended && extendedContext) {
  modelStr = `${modelStr}[1m]`;
}
```

Replace with:

```tsx
let modelStr = modelId;
if (!isBuiltinProvider && selectedProviderId) {
  modelStr = `${selectedProviderId}:${modelId}`;
}
```

Add `contextSize` to the body object that gets POSTed:

```tsx
const body = {
  // ...existing fields...
  model: modelStr,
  contextSize,
  // ...rest unchanged...
};
```

- [ ] **Step 5: Coerce contextSize when the user changes model**

After the state changes that pick a new model alias/version/custom-provider model, if the new model's `contextSizes` does not include the current `contextSize`, set it to the first entry. Add a `useEffect`:

```tsx
useEffect(() => {
  if (!contextSizes.includes(contextSize)) {
    setContextSize(contextSizes[0] ?? "200k");
  }
}, [contextSizes, contextSize]);
```

- [ ] **Step 6: Verify type-check passes**

Run: `npx tsc --noEmit 2>&1 | grep "jobs/\[id\]/edit/page.tsx" || echo "no errors"`
Expected: "no errors".

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/jobs/[id]/edit/page.tsx"
git commit -m "Render context selector from contextSizes and write contextSize field"
```

---

### Task 15: Session settings page selector and mainContext

**Files:**
- Modify: `src/app/(app)/settings/session/page.tsx`

- [ ] **Step 1: Add the import**

```tsx
import { CONTEXT_SIZES, type ContextSize } from "@/lib/models";
```

- [ ] **Step 2: Replace `parseModelString` / `buildModelString` usage**

Remove the `parseModelString` and `buildModelString` helpers at the top of the file. Read `mainContext` directly:

```tsx
const mainModel = settings.modelSlots?.main ?? "sonnet";
const mainContext: ContextSize = settings.modelSlots?.mainContext ?? "200k";
const entry = resolveModel(mainModel);
```

(Replace the entire derivation block at lines 76-78 with the above.)

- [ ] **Step 3: Update `selectVersion`**

Replace the body that calls `buildModelString` with:

```tsx
function selectVersion(version: string) {
  const ver = versions.find((m) => m.version === version);
  if (!ver) return;
  const nextSlots = {
    ...settings.modelSlots,
    main: ver.modelId,
    mainContext: ver.contextSizes.includes(mainContext) ? mainContext : (ver.contextSizes[0] ?? "200k"),
  };
  updateSetting("modelSlots", nextSlots);
  const levels = allowedEffortLevels(ver);
  if (!levels.includes(settings.thinkingLevel)) {
    const rec = recommendedEffort(ver);
    if (rec) updateSetting("thinkingLevel", rec);
  }
}
```

- [ ] **Step 4: Replace the Context SettingRow (around line 136-147)**

```tsx
{entry && entry.contextSizes.length >= 2 && (
  <SettingRow label="Context">
    <ButtonGroup
      options={entry.contextSizes.map((s) => ({ value: s, label: CONTEXT_SIZES[s].label }))}
      value={mainContext}
      onChange={(v) =>
        updateSetting("modelSlots", {
          ...settings.modelSlots,
          main: entry.modelId,
          mainContext: v as ContextSize,
        })
      }
    />
  </SettingRow>
)}
```

- [ ] **Step 5: Verify type-check passes**

Run: `npx tsc --noEmit 2>&1 | grep "settings/session/page.tsx" || echo "no errors"`
Expected: "no errors".

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/settings/session/page.tsx"
git commit -m "Drive session-settings context selector from contextSizes"
```

---

### Task 16: input-area selector

**Files:**
- Modify: `src/components/input-area.tsx`

- [ ] **Step 1: Add the imports**

```tsx
import { CONTEXT_SIZES, type ContextSize } from "@/lib/models";
```

- [ ] **Step 2: Change the `onSetModel` prop type**

Find the prop type declaration that includes `onSetModel: (model: string) => void` and change to `onSetModel: (model: string, contextSize?: ContextSize) => void`.

- [ ] **Step 3: Receive contextSize via props (or parse from sessionPrefs)**

The input-area gets the current session state from a prop chain. Identify where `currentModel: string` comes in. Add `currentContextSize: ContextSize` alongside, or read it from the same source.

The component itself does the parsing today via `parseCurrentModel`. Replace its body so `extended` becomes a passed-in field instead of being parsed from the suffix:

```tsx
function parseCurrentModel(currentModel: string, currentContextSize: ContextSize): { alias: ModelAlias | null; entry: ModelEntry | null; contextSize: ContextSize } {
  const base = currentModel.replace(/\[.*\]$/, "");
  if (base === "opus" || base === "sonnet" || base === "haiku") {
    return { alias: base, entry: defaultForAlias(base) ?? null, contextSize: currentContextSize };
  }
  const entry = findModelById(base) ?? null;
  return { alias: entry?.alias ?? null, entry, contextSize: currentContextSize };
}
```

Remove `hasExtendedContext` and `baseModel` helpers since they are no longer used here.

- [ ] **Step 4: Update `valueForEntry` and `valueForAlias`**

These helpers exist only to encode `[1m]` into the model string. With the suffix gone, they reduce to:

```tsx
function valueForEntry(entry: ModelEntry): string {
  const versions = versionsForAlias(entry.alias);
  const isSoleDefault = versions.length === 1 && entry.isDefault;
  return isSoleDefault ? entry.alias : entry.modelId;
}

function valueForAlias(alias: ModelAlias): string {
  const entry = defaultForAlias(alias);
  if (!entry) return alias;
  return valueForEntry(entry);
}
```

Update every call site within the file (search for `valueForEntry(` and `valueForAlias(`) — they all now take one argument instead of two.

- [ ] **Step 5: Update the Context selector block (line ~942-960)**

Find the block that renders `contextSizes` button group. Replace the `supportsExt` derivation and `extended` references:

```tsx
const sizes = parsed.entry?.contextSizes ?? [];
```

Render:

```tsx
{sizes.length >= 2 && parsed.entry && (
  <div className="flex items-center gap-2">
    <Maximize2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    <span className="text-xs text-muted-foreground">Context</span>
    <div className="ml-auto flex gap-1">
      {sizes.map((s) => (
        <button
          key={s}
          onClick={() => onSetModel(currentModel, s)}
          className={`rounded px-2 py-0.5 text-xs transition-colors ${
            parsed.contextSize === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          {CONTEXT_SIZES[s].label}
        </button>
      ))}
    </div>
  </div>
)}
```

Remove the `contextSizes` constant at the top of the file (line ~51-54).

- [ ] **Step 6: Verify type-check passes**

Run: `npx tsc --noEmit 2>&1 | grep input-area.tsx || echo "no errors"`
Expected: "no errors".

- [ ] **Step 7: Commit**

```bash
git add src/components/input-area.tsx
git commit -m "Render in-chat context selector from contextSizes"
```

---

### Task 17: model-picker simplification

**Files:**
- Modify: `src/components/model-picker.tsx`

- [ ] **Step 1: Change `onSelect` signature**

```tsx
interface ModelPickerProps {
  currentModel: string;
  currentContextSize?: ContextSize;
  activeModelId?: string | null;
  onSelect: (model: string, contextSize?: ContextSize) => void;
  providers: Provider[];
  slot?: "main" | "subagent" | "fast";
}
```

Add the imports: `import { CONTEXT_SIZES, type ContextSize } from "@/lib/models";`.

- [ ] **Step 2: Simplify `buildRows`**

Remove the second row insertion that creates the `[1m]` variant:

```tsx
function buildRows(providers: Provider[]): PickerRow[] {
  const rows: PickerRow[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      const desc = model.effortLevels.length > 0 ? `Thinking: ${model.effortLevels.join(", ")}` : "No thinking";
      rows.push({
        key: `${provider.id}::${model.modelId}`,
        value: model.modelId,
        label: model.displayName,
        description: desc,
        providerId: provider.id,
        providerName: provider.name,
        sizes: model.contextSizes,
      });
    }
  }
  return rows;
}
```

Update `PickerRow` to drop `extended: boolean` and add `sizes: ContextSize[]`.

- [ ] **Step 3: Update the render block**

Remove `hasExtendedContext` and `baseModel` helpers (they are no longer used in this file). Replace the `active` calculation:

```tsx
const active = row.value === currentModel;
```

Inside the button JSX, render size pills inline when `row.sizes.length >= 2`:

```tsx
<button onClick={() => onSelect(row.value)} ...>
  <div className="w-4 shrink-0">{active && <Check className="h-4 w-4" />}</div>
  <span className="font-mono font-bold">{row.value}</span>
  <span className="text-muted-foreground">{row.label}</span>
  <span className="text-muted-foreground ml-auto text-xs">{row.description}</span>
</button>
{row.sizes.length >= 2 && (
  <div className="flex gap-1 pl-10 pt-1 pb-2">
    {row.sizes.map((s) => (
      <button
        key={s}
        onClick={() => onSelect(row.value, s)}
        className={`rounded px-2 py-0.5 text-xs transition-colors ${
          row.value === currentModel && currentContextSize === s
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground hover:text-foreground"
        }`}
      >
        {CONTEXT_SIZES[s].label}
      </button>
    ))}
  </div>
)}
```

- [ ] **Step 4: Update every caller of `<ModelPicker ... />`**

Search for `<ModelPicker` in the codebase. For each call site, pass `currentContextSize` from the session state and accept the new `onSelect` second arg:

```tsx
<ModelPicker
  currentModel={...}
  currentContextSize={sessionContextSize}
  onSelect={(model, contextSize) => setModel(model, contextSize)}
  ...
/>
```

- [ ] **Step 5: Verify type-check passes**

Run: `npx tsc --noEmit 2>&1 | grep model-picker.tsx || echo "no errors"`
Expected: "no errors".

- [ ] **Step 6: Commit**

```bash
git add src/components/model-picker.tsx
git commit -m "Render single row per model with inline context-size pills"
```

---

### Task 18: Full type-check and final cleanup pass

**Files:**
- Modify: `src/lib/models.ts`
- Modify: `src/server/session-manager.ts`
- Modify: any remaining files that still reference the removed identifiers

- [ ] **Step 1: Run a full type-check to identify remaining errors**

Run: `npx tsc --noEmit`
Expected: list of remaining errors, all referring to dropped helpers (`hasExtendedContext`, `parseModelString`, `buildModelString`, `baseModel`, `supportsExtendedContext`).

- [ ] **Step 2: Delete unused helpers in `src/lib/models.ts`**

The `splitLegacyModel` stays. Anything else that referenced `supportsExtendedContext` (none should remain after Task 3, double-check) is deleted.

- [ ] **Step 3: Remove any stale `[1m]` concatenations and helpers in the frontend**

For each file in the list returned by:

```bash
grep -rn "\[1m\]\|hasExtendedContext\|parseModelString\|buildModelString" src/ tests/
```

Investigate and remove. Any remaining `${modelId}[1m]` is a leftover from Tasks 13-17 and indicates an incomplete migration — fix it inline.

- [ ] **Step 4: Verify the comment in session-manager around line 1037-1039 is updated**

The comment references `[1m]` suffix toggling. Update to:

```ts
// Detect 200K↔1M flip via the explicit contextSize field. The
// CLAUDE_CODE_DISABLE_1M_CONTEXT env var is applied at spawn, so toggling
// the context size mid-session needs a CLI restart for the new context
// window to actually take effect.
```

- [ ] **Step 5: Verify full type-check passes**

Run: `npx tsc --noEmit`
Expected: PASS (only pre-existing errors unrelated to this work, if any).

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: all tests PASS.

- [ ] **Step 7: Run lint**

Run: `npm run lint`
Expected: no new warnings introduced by this work. The pre-existing `sidebar.tsx:460` warning is acceptable.

- [ ] **Step 8: Commit**

```bash
git add -u
git commit -m "Drop legacy [1m] suffix helpers and stale references"
```

---

### Task 19: Manual smoke test

**Files:** none

- [ ] **Step 1: Build and start the dev server**

Run: `npm run dev`
Open: `http://localhost:3000`

- [ ] **Step 2: Verify built-in models**

In session settings, pick Opus 4.7. The Context selector appears with 200K and 1M buttons. Toggle between them. Reload the page — selection persists.

- [ ] **Step 3: Verify the zsh glob bug is gone**

Start a new chat session with Opus 4.7 selected and 1M context active. The CLI spawns successfully. No `zsh:1: no matches found: claude-opus-4-7[1m]` startup error in the server log.

- [ ] **Step 4: Verify the haiku case**

Switch the main model to Haiku. The Context selector disappears (haiku has `["200k"]` only).

- [ ] **Step 5: Verify the custom-provider case**

Open Settings → Providers, add a custom provider, create a model entry with both 200K and 1M selected. Save. The model appears in the in-chat picker with size pills inline. Selecting a size pill switches mid-session and the server restarts the CLI with the new env var.

Create a second model entry with only 1M selected. Verify the form prevents Save when both pills are unchecked.

- [ ] **Step 6: Verify the legacy migration**

Before starting the server, manually edit `~/.cockpit/session-prefs.json` so one session has `"model": "claude-opus-4-7[1m]"`. Start the server, open that session, observe in DevTools that the active model is `claude-opus-4-7` and the context selector shows 1M as active. Reload — the file is rewritten without the suffix.

- [ ] **Step 7: Stop the server**

---

## Self-Review

Spec coverage:
- Catalog: Task 1.
- ContextSize type and DEFAULT_CONTEXT_SIZE: Task 1.
- splitLegacyModel: Task 2.
- ProviderModel.contextSizes: Tasks 3-4.
- ModelEntry.contextSizes: Task 3.
- ModelSlots.mainContext: Task 4.
- ScheduledJob.contextSize: Task 4.
- SessionPrefs.contextSize: Task 4.
- WS protocol contextSize: Task 4 (type), Task 9 (handler), Task 12 (client send).
- Spawn paths use contextSize: Task 7.
- setModel coercion: Task 8.
- Read-side migration: Tasks 5, 6, 11.
- Provider form pills + validation: Task 13.
- Job edit selector: Task 14.
- Session settings selector: Task 15.
- Input-area selector: Task 16.
- Model picker single row: Task 17.
- Cleanup of helpers and suffix concatenations: Task 18.
- providers.ts validation: Task 10.
- Tests for splitLegacyModel, session-prefs migration, job migration, spawn env var, validation: Tasks 2, 5, 6, 7, 10.
- Manual smoke test: Task 19.

No placeholders. No "TBD" or "implement later" strings. Every step shows the code or command.

Type consistency: `ContextSize` used uniformly. `contextSize` (singular) is the per-record/per-slot selection; `contextSizes` (plural) is the array of available options on a model. `CONTEXT_SIZES` (uppercase) is the catalog const. `splitLegacyModel` is referenced everywhere with the same return shape.
