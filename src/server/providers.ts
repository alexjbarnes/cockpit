import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { toProviderModels } from "@/lib/models";
import { type FormatProxy, getActiveFormatProxy } from "@/server/format-proxy";
import { getCockpitDir } from "@/server/paths";
import { catalogModels, loadCatalog, OPENROUTER_PROVIDER_ID, openRouterBaseUrl } from "@/server/provider-catalog";
import type { Provider, ProviderModel, ThinkingLevel } from "@/types";

export const OPENCODE_ZEN_PROVIDER_ID = "zen";
export const DEEPSEEK_PROVIDER_ID = "deepseek";
/** Test escape hatches mirror COCKPIT_OPENROUTER_BASE_URL. */
export function zenBaseUrl(): string {
  return process.env.COCKPIT_ZEN_BASE_URL || "https://opencode.ai/zen/v1";
}
export function deepseekBaseUrl(): string {
  return process.env.COCKPIT_DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic";
}
/** DeepSeek's OpenAI-side endpoints (key validation via /v1/models, and
 *  /user/balance) live on the API root, not under the Anthropic door. */
function deepseekApiRoot(): string {
  return deepseekBaseUrl().replace(/\/anthropic\/?$/, "");
}

const BUILTIN_CONFIG_IDS = new Set<string>([OPENROUTER_PROVIDER_ID, OPENCODE_ZEN_PROVIDER_ID, DEEPSEEK_PROVIDER_ID]);

/** Catalog-backed built-ins (openrouter, zen, deepseek). Sessions on their
 *  models get the pinned default-model env and derived wiring at spawn. */
export function isBuiltinCatalogProvider(id: string): boolean {
  return BUILTIN_CONFIG_IDS.has(id);
}

/** Built-ins that speak OpenAI wire format through the cockpit proxy (DeepSeek
 *  is NOT one — it ships an Anthropic-native endpoint and runs passthrough):
 *  the env var holding the stored key and the upstream base. */
const OPENAI_WIRE_BUILTINS: Record<string, { name: string; keyEnvVar: string; baseUrl: () => string }> = {
  [OPENCODE_ZEN_PROVIDER_ID]: { name: "OpenCode Zen", keyEnvVar: "OPENCODE_API_KEY", baseUrl: zenBaseUrl },
};

function prefsDir(): string {
  return getCockpitDir();
}
function providersFile(): string {
  return join(prefsDir(), "providers.json");
}

function validateProvider(p: Pick<Provider, "models"> & { id?: string }): void {
  for (const m of p.models) {
    if (!Array.isArray(m.contextSizes) || m.contextSizes.length === 0) {
      throw new Error(`provider${p.id ? ` ${p.id}` : ""}: model ${m.modelId} has empty contextSizes`);
    }
  }
}

function buildAnthropicProvider(): Provider {
  return {
    id: "anthropic",
    name: "Anthropic",
    envVars: {},
    models: toProviderModels(),
    isBuiltin: true,
  };
}

/** The stored openrouter entry in providers.json carries only user state (the
 *  key and the curated enabled set); models always come from the synced
 *  catalog and env is derived, so a stale file can never pin stale wiring. */
function buildOpenRouterProvider(stored: Provider | undefined): Provider {
  const key = stored?.envVars?.ANTHROPIC_AUTH_TOKEN;
  return {
    id: OPENROUTER_PROVIDER_ID,
    name: "OpenRouter",
    // Stored extras pass through, but the wire vars are always derived.
    // ANTHROPIC_API_KEY must be an explicitly empty string, not unset —
    // otherwise the CLI can fall back to authenticating against Anthropic.
    // Nonessential traffic (bootstrap probes, utility calls) is disabled so
    // background requests never quietly spend OpenRouter credits.
    // When the format proxy is up, sessions route through it in anthropic
    // passthrough mode purely for the bounded 429 retry (congested free
    // models); the CLI still authenticates with the real key, the proxy just
    // relays. Direct URL is the fallback when the proxy is not running.
    envVars: key
      ? {
          ...stored?.envVars,
          ANTHROPIC_BASE_URL: getActiveFormatProxy()?.isRunning
            ? (getActiveFormatProxy() as FormatProxy).getUrl(OPENROUTER_PROVIDER_ID)
            : openRouterBaseUrl(),
          ANTHROPIC_AUTH_TOKEN: key,
          ANTHROPIC_API_KEY: "",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        }
      : {},
    models: catalogModels(),
    isBuiltin: true,
    enabledModels: stored?.enabledModels ?? [],
    syncedAt: loadCatalog()?.syncedAt,
  };
}

/** Per-session env for an OpenRouter spawn. The CLI's internal utility calls
 *  use the opus/sonnet/haiku-class default models; left unset they route to
 *  Claude models billed on OpenRouter credits behind the user's back, so every
 *  slot is pinned to the session's catalog models. */
export function openRouterModelEnv(mainModelId: string, subagentModelId?: string): Record<string, string> {
  const sub = subagentModelId || mainModelId;
  return {
    ANTHROPIC_DEFAULT_OPUS_MODEL: mainModelId,
    ANTHROPIC_DEFAULT_SONNET_MODEL: mainModelId,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: sub,
    CLAUDE_CODE_SUBAGENT_MODEL: sub,
  };
}

let cache: Provider[] | null = null;
// mtime of providers.json at the last load. Cockpit runs as two separate module
// graphs — the custom server (dist/, which spawns sessions) and the Next.js API
// routes (settings CRUD) — so a provider added/edited via settings only resets
// that graph's `cache`, never the spawner's, leaving new sessions on a stale list
// until restart. Gating the cache on the file mtime makes either graph (and a
// hand-edit of the file) reload when the file changes.
let cacheMtimeMs = 0;

function providersMtimeMs(): number {
  // The openrouter built-in derives its model list from the synced catalog, so
  // either file changing must invalidate the provider cache.
  let m = 0;
  for (const file of [providersFile(), join(prefsDir(), "provider-catalog.json")]) {
    try {
      m += statSync(file).mtimeMs;
    } catch {
      // file absent
    }
  }
  return m;
}

function loadStored(): Provider[] {
  try {
    return JSON.parse(readFileSync(providersFile(), "utf-8"));
  } catch {
    return [];
  }
}

function loadCustom(): Provider[] {
  return loadStored().filter((p) => !BUILTIN_CONFIG_IDS.has(p.id));
}

function loadBuiltinStored(id: string): Provider | undefined {
  return loadStored().find((p) => p.id === id);
}

const BUILTIN_NAMES: Record<string, string> = {
  [OPENROUTER_PROVIDER_ID]: "OpenRouter",
  [OPENCODE_ZEN_PROVIDER_ID]: "OpenCode Zen",
  [DEEPSEEK_PROVIDER_ID]: "DeepSeek",
};

/** Persist a built-in's user state (key, enabled set, and for zen the synced
 *  model list) as an entry in providers.json alongside the custom providers. */
function saveBuiltinStored(id: string, partial: Partial<Provider>): Provider {
  const prev = loadBuiltinStored(id);
  const entry: Provider = {
    id,
    name: BUILTIN_NAMES[id] ?? id,
    isBuiltin: true,
    models: partial.models ?? prev?.models ?? [],
    envVars: partial.envVars ?? prev?.envVars ?? {},
    enabledModels: partial.enabledModels ?? prev?.enabledModels ?? [],
    syncedAt: partial.syncedAt ?? prev?.syncedAt,
  };
  saveCustom(loadCustom(), entry);
  return entry;
}

function saveCustom(providers: Provider[], replaceEntry?: Provider): void {
  try {
    mkdirSync(prefsDir(), { recursive: true });
    const builtins: Provider[] = [];
    for (const id of BUILTIN_CONFIG_IDS) {
      if (replaceEntry?.id === id) builtins.push(replaceEntry);
      else {
        const existing = loadBuiltinStored(id);
        if (existing) builtins.push(existing);
      }
    }
    writeFileSync(providersFile(), JSON.stringify([...builtins, ...providers], null, 2) + "\n");
  } catch {
    // best effort
  }
}

/** Zen and DeepSeek speak OpenAI wire format only, so a connected session
 *  points the CLI at cockpit's format proxy, which forwards upstream with the
 *  stored key. The key is stored under the provider's own env var name and
 *  never sent by the CLI. */
function buildOpenAIWireProvider(id: string, stored: Provider | undefined): Provider {
  const cfg = OPENAI_WIRE_BUILTINS[id];
  const key = stored?.envVars?.[cfg.keyEnvVar];
  const proxy = getActiveFormatProxy();
  // The key var is always present when connected so the settings UI (which
  // runs in the Next.js module graph, where the proxy singleton may be absent)
  // can tell connected from not; the wire vars appear only where the proxy is
  // live, which is the graph that actually spawns sessions.
  return {
    id,
    name: cfg.name,
    envVars: key
      ? {
          [cfg.keyEnvVar]: key,
          ...(proxy?.isRunning
            ? {
                ANTHROPIC_BASE_URL: proxy.getUrl(id),
                ANTHROPIC_AUTH_TOKEN: "cockpit-format-proxy",
                ANTHROPIC_API_KEY: "",
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
              }
            : {}),
        }
      : {},
    models: stored?.models ?? [],
    isBuiltin: true,
    enabledModels: stored?.enabledModels ?? [],
    syncedAt: stored?.syncedAt,
  };
}

/** DeepSeek ships an Anthropic-native endpoint (api.deepseek.com/anthropic),
 *  so sessions speak to it without translation — through the proxy in
 *  anthropic passthrough mode when it is up (bounded retry on saturation),
 *  direct otherwise. The stored DEEPSEEK_API_KEY doubles as the wire
 *  ANTHROPIC_AUTH_TOKEN, so the CLI authenticates itself either way. */
function buildDeepSeekProvider(stored: Provider | undefined): Provider {
  const key = stored?.envVars?.DEEPSEEK_API_KEY;
  return {
    id: DEEPSEEK_PROVIDER_ID,
    name: "DeepSeek",
    envVars: key
      ? {
          DEEPSEEK_API_KEY: key,
          ANTHROPIC_BASE_URL: getActiveFormatProxy()?.isRunning
            ? (getActiveFormatProxy() as FormatProxy).getUrl(DEEPSEEK_PROVIDER_ID)
            : deepseekBaseUrl(),
          ANTHROPIC_AUTH_TOKEN: key,
          ANTHROPIC_API_KEY: "",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        }
      : {},
    models: stored?.models ?? [],
    isBuiltin: true,
    enabledModels: stored?.enabledModels ?? [],
    syncedAt: stored?.syncedAt,
  };
}

/** Upstream config for the format proxy. Null when the provider is not
 *  connected (no key) — the proxy 404s those. */
export function resolveProxyUpstream(providerId: string): {
  baseUrl: string;
  apiKey: string;
  modelIds: string[];
  wireFormat?: "openai" | "anthropic";
  effortByModel?: Record<string, string[]>;
} | null {
  if (providerId === OPENROUTER_PROVIDER_ID) {
    const stored = loadBuiltinStored(OPENROUTER_PROVIDER_ID);
    const apiKey = stored?.envVars?.ANTHROPIC_AUTH_TOKEN;
    if (!apiKey) return null;
    return { baseUrl: openRouterBaseUrl(), apiKey, modelIds: catalogModels().map((m) => m.modelId), wireFormat: "anthropic" };
  }
  if (providerId === DEEPSEEK_PROVIDER_ID) {
    const stored = loadBuiltinStored(DEEPSEEK_PROVIDER_ID);
    const apiKey = stored?.envVars?.DEEPSEEK_API_KEY;
    if (!apiKey) return null;
    return { baseUrl: deepseekBaseUrl(), apiKey, modelIds: (stored?.models ?? []).map((m) => m.modelId), wireFormat: "anthropic" };
  }
  const cfg = OPENAI_WIRE_BUILTINS[providerId];
  if (!cfg) return null;
  const stored = loadBuiltinStored(providerId);
  const apiKey = stored?.envVars?.[cfg.keyEnvVar];
  if (!apiKey) return null;
  const models = stored?.models ?? [];
  const effortByModel: Record<string, string[]> = {};
  for (const m of models) if ((m.effortLevels ?? []).length > 0) effortByModel[m.modelId] = m.effortLevels;
  return { baseUrl: cfg.baseUrl(), apiKey, modelIds: models.map((m) => m.modelId), effortByModel };
}

interface ModelsDevEntry {
  name?: string;
  cost?: { input?: number; output?: number };
  limit?: { context?: number };
  tool_call?: boolean;
  reasoning?: boolean;
  reasoning_options?: Array<{ type?: string; values?: string[] }>;
  modalities?: { input?: string[] };
}

const MODELS_DEV_CACHE_MS = 60 * 60 * 1000;
const modelsDevCache = new Map<string, { at: number; models: Record<string, ModelsDevEntry> }>();

/** Pricing/capability metadata from models.dev — the OpenCode team's model
 *  database (the zen docs pricing table is built from it): cost per 1M,
 *  context windows, capability flags, and reasoning effort values, keyed by
 *  models.dev provider id ("opencode" for zen, "deepseek"). One fetch fills
 *  the cache for every provider. Best-effort: a failed fetch returns {} and
 *  callers degrade to bare model lists. */
async function fetchModelsDevModels(providerKey: string): Promise<Record<string, ModelsDevEntry>> {
  const hit = modelsDevCache.get(providerKey);
  if (hit && Date.now() - hit.at < MODELS_DEV_CACHE_MS) return hit.models;
  try {
    const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return {};
    const body = (await res.json()) as Record<string, { models?: Record<string, ModelsDevEntry> } | undefined>;
    const now = Date.now();
    for (const [key, entry] of Object.entries(body)) {
      if (entry?.models) modelsDevCache.set(key, { at: now, models: entry.models });
    }
    return modelsDevCache.get(providerKey)?.models ?? {};
  } catch {
    return {};
  }
}

const EFFORT_ORDER: ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** Effort levels a synced model supports, from models.dev reasoning_options
 *  (e.g. deepseek v4: [{type:"toggle"}, {type:"effort", values:["high","max"]}]).
 *  Only values in cockpit's ThinkingLevel vocabulary survive. */
function metaEffortLevels(m: ModelsDevEntry | undefined): ThinkingLevel[] {
  const values = (m?.reasoning_options ?? []).filter((o) => o.type === "effort").flatMap((o) => o.values ?? []);
  return EFFORT_ORDER.filter((l) => values.includes(l));
}

function modelFromMeta(id: string, m: ModelsDevEntry | undefined): ProviderModel {
  // Free is zero cost when metadata exists (catches unsuffixed free models
  // like big-pickle); the "-free" id suffix is the fallback signal.
  const free = m?.cost ? (m.cost.input ?? 0) === 0 && (m.cost.output ?? 0) === 0 : /-free$/.test(id);
  return {
    modelId: id,
    displayName: m?.name || id,
    effortLevels: metaEffortLevels(m),
    contextSizes: [],
    contextLength: m?.limit?.context,
    pricing: m?.cost ? { inPerM: m.cost.input ?? 0, outPerM: m.cost.output ?? 0 } : undefined,
    free,
    supportsTools: m?.tool_call,
    supportsReasoning: m?.reasoning,
    supportsImageInput: m?.modalities?.input?.includes("image"),
  };
}

/** Persist a sync result on a builtin entry. Curation rules: a connected
 *  provider keeps its enabled set, with a fresh connect starting fully
 *  enabled; an unconnected one never gains enabled models from a background
 *  sync — pickers only offer connected providers. */
function saveSyncedBuiltin(
  id: string,
  keyEnvVar: string,
  stored: Provider | undefined,
  apiKey: string | undefined,
  models: ProviderModel[],
): void {
  const ids = models.map((m) => m.modelId);
  const prevEnabled = new Set(stored?.enabledModels ?? []);
  const enabledModels = apiKey ? ids.filter((mid) => prevEnabled.size === 0 || prevEnabled.has(mid)) : (stored?.enabledModels ?? []);
  saveBuiltinStored(id, {
    envVars: apiKey ? { ...stored?.envVars, [keyEnvVar]: apiKey } : { ...stored?.envVars },
    models,
    enabledModels,
    syncedAt: Date.now(),
  });
  rebuildCache(loadCustom());
}

/** Fetch zen's OpenAI-style model list (the endpoint is public — the key is
 *  optional) and enrich it from models.dev. A keyless sync only refreshes the
 *  browsable list; connect (keyOverride) also stores the key. */
export async function syncZenModels(keyOverride?: string): Promise<{ ok: boolean; modelCount?: number; error?: string }> {
  const stored = loadBuiltinStored(OPENCODE_ZEN_PROVIDER_ID);
  const apiKey = keyOverride ?? stored?.envVars?.OPENCODE_API_KEY;
  try {
    const res = await fetch(`${zenBaseUrl()}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, error: `Zen models fetch failed: HTTP ${res.status}` };
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
    if (ids.length === 0) return { ok: false, error: "Zen models fetch returned no models" };

    const meta = await fetchModelsDevModels("opencode");
    const models = ids.map((id) => modelFromMeta(id, meta[id]));
    saveSyncedBuiltin(OPENCODE_ZEN_PROVIDER_ID, "OPENCODE_API_KEY", stored, apiKey, models);
    return { ok: true, modelCount: models.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** DeepSeek's catalog comes from models.dev (public, keyless); when a key is
 *  present the authenticated /v1/models list — DeepSeek 401s bad keys, unlike
 *  zen's open endpoint, so connect validation is real — becomes the id source
 *  of truth for what the key can actually run. */
export async function syncDeepSeekModels(keyOverride?: string): Promise<{ ok: boolean; modelCount?: number; error?: string }> {
  const stored = loadBuiltinStored(DEEPSEEK_PROVIDER_ID);
  const apiKey = keyOverride ?? stored?.envVars?.DEEPSEEK_API_KEY;
  try {
    const meta = await fetchModelsDevModels("deepseek");
    let ids = Object.keys(meta);
    if (apiKey) {
      const res = await fetch(`${deepseekApiRoot()}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 401 || res.status === 403) return { ok: false, error: "DeepSeek rejected the API key" };
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<{ id?: string }> };
        const live = (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
        if (live.length > 0) ids = live;
      }
    }
    if (ids.length === 0) return { ok: false, error: "DeepSeek model list is empty" };
    const models = ids.map((id) => modelFromMeta(id, meta[id]));
    saveSyncedBuiltin(DEEPSEEK_PROVIDER_ID, "DEEPSEEK_API_KEY", stored, apiKey, models);
    return { ok: true, modelCount: models.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const BUILTIN_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
let builtinSyncTimer: ReturnType<typeof setInterval> | null = null;

/** Boot-time plus daily refresh of the proxied built-ins' model lists. Both
 *  sources are public (zen /models, models.dev), so this runs whether or not
 *  a key is connected — the providers page shows model and free counts before
 *  connect, and connected installs stay fresh without manual syncs. Failures
 *  stay silent (best-effort; the next tick retries). */
export function startBuiltinModelSync(): void {
  if (builtinSyncTimer) return;
  const run = () => {
    const syncs: Array<[string, () => Promise<unknown>]> = [
      [OPENCODE_ZEN_PROVIDER_ID, () => syncZenModels()],
      [DEEPSEEK_PROVIDER_ID, () => syncDeepSeekModels()],
    ];
    for (const [id, sync] of syncs) {
      const syncedAt = loadBuiltinStored(id)?.syncedAt ?? 0;
      if (Date.now() - syncedAt < BUILTIN_SYNC_INTERVAL_MS) continue;
      void sync();
    }
  };
  run();
  builtinSyncTimer = setInterval(run, BUILTIN_SYNC_INTERVAL_MS);
  builtinSyncTimer.unref?.();
}

export interface DeepSeekBalance {
  currency: string;
  totalBalance: number;
  grantedBalance: number;
  toppedUpBalance: number;
}

const BALANCE_CACHE_MS = 60_000;
let balanceCache: { at: number; data: DeepSeekBalance } | null = null;

/** Account balance for the stored DeepSeek key (GET /user/balance on the API
 *  root). Null when not connected; cached a minute like the OpenRouter usage
 *  snapshot. */
export async function getDeepSeekBalance(): Promise<DeepSeekBalance | null> {
  const key = loadBuiltinStored(DEEPSEEK_PROVIDER_ID)?.envVars?.DEEPSEEK_API_KEY;
  if (!key) return null;
  if (balanceCache && Date.now() - balanceCache.at < BALANCE_CACHE_MS) return balanceCache.data;
  const res = await fetch(`${deepseekApiRoot()}/user/balance`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`balance fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as {
    balance_infos?: Array<{ currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }>;
  };
  const info = body.balance_infos?.[0];
  const data: DeepSeekBalance = {
    currency: info?.currency ?? "USD",
    totalBalance: Number(info?.total_balance ?? 0),
    grantedBalance: Number(info?.granted_balance ?? 0),
    toppedUpBalance: Number(info?.topped_up_balance ?? 0),
  };
  balanceCache = { at: Date.now(), data };
  return data;
}

function rebuildCache(custom: Provider[]): void {
  cache = [
    buildAnthropicProvider(),
    buildOpenRouterProvider(loadBuiltinStored(OPENROUTER_PROVIDER_ID)),
    buildOpenAIWireProvider(OPENCODE_ZEN_PROVIDER_ID, loadBuiltinStored(OPENCODE_ZEN_PROVIDER_ID)),
    buildDeepSeekProvider(loadBuiltinStored(DEEPSEEK_PROVIDER_ID)),
    ...custom,
  ];
  cacheMtimeMs = providersMtimeMs();
}

export function getProviders(): Provider[] {
  const mtime = providersMtimeMs();
  if (cache === null || mtime !== cacheMtimeMs) {
    rebuildCache(loadCustom());
  }
  return cache as Provider[];
}

export function getProvider(id: string): Provider | undefined {
  return getProviders().find((p) => p.id === id);
}

export function addProvider(provider: Omit<Provider, "id">): Provider {
  const newProvider: Provider = { ...provider, id: uuidv4() };
  validateProvider(newProvider);
  const custom = getProviders().filter((p) => !p.isBuiltin);
  custom.push(newProvider);
  saveCustom(custom);
  rebuildCache(custom);
  return newProvider;
}

export function updateProvider(id: string, partial: Partial<Provider>): Provider {
  if (id === "anthropic") throw new Error("Cannot modify built-in provider");
  // Catalog-backed built-ins accept only their user state: the key (envVars),
  // the curated enabled set, and (zen) the synced model list. Their models are
  // never hand-edited, so the contextSizes validation does not apply.
  if (BUILTIN_CONFIG_IDS.has(id)) {
    const entry = saveBuiltinStored(id, { envVars: partial.envVars, enabledModels: partial.enabledModels, models: partial.models });
    rebuildCache(loadCustom());
    if (id === OPENROUTER_PROVIDER_ID) return buildOpenRouterProvider(entry);
    if (id === DEEPSEEK_PROVIDER_ID) return buildDeepSeekProvider(entry);
    return buildOpenAIWireProvider(id, entry);
  }
  const custom = getProviders().filter((p) => !p.isBuiltin);
  const idx = custom.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Provider not found: ${id}`);
  const merged = { ...custom[idx], ...partial, id };
  validateProvider(merged);
  custom[idx] = merged;
  saveCustom(custom);
  rebuildCache(custom);
  return custom[idx];
}

export function deleteProvider(id: string): void {
  if (id === "anthropic" || BUILTIN_CONFIG_IDS.has(id)) throw new Error("Cannot delete built-in provider");
  const custom = getProviders().filter((p) => !p.isBuiltin);
  const remaining = custom.filter((p) => p.id !== id);
  if (remaining.length === custom.length) {
    throw new Error(`Provider not found: ${id}`);
  }
  saveCustom(remaining);
  rebuildCache(remaining);
}

export function setProviders(providers: Provider[]): void {
  const custom = providers.filter((p) => !p.isBuiltin);
  for (const p of custom) validateProvider(p);
  saveCustom(custom);
  rebuildCache(custom);
}

export function resolveProviderModel(modelId: string): { provider: Provider; model: ProviderModel } | null {
  if (!modelId) return null;

  const colon = modelId.indexOf(":");
  if (colon > 0) {
    const providerId = modelId.slice(0, colon);
    // Strip a legacy context suffix (e.g. "deepseek-v4-pro[1m]") so a job whose
    // stored model still carries one resolves to the cleaned provider model.
    const bareModel = modelId.slice(colon + 1).replace(/\[.*\]$/, "");
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
