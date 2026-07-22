import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { toProviderModels } from "@/lib/models";
import { type FormatProxy, getActiveFormatProxy } from "@/server/format-proxy";
import { getCockpitDir } from "@/server/paths";
import { catalogModels, loadCatalog, OPENROUTER_PROVIDER_ID, openRouterBaseUrl } from "@/server/provider-catalog";
import type { Provider, ProviderModel } from "@/types";

export const OPENCODE_ZEN_PROVIDER_ID = "zen";
/** Test escape hatch mirrors COCKPIT_OPENROUTER_BASE_URL. */
export function zenBaseUrl(): string {
  return process.env.COCKPIT_ZEN_BASE_URL || "https://opencode.ai/zen/v1";
}

const BUILTIN_CONFIG_IDS = new Set<string>([OPENROUTER_PROVIDER_ID, OPENCODE_ZEN_PROVIDER_ID]);

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

/** OpenCode Zen speaks OpenAI wire format only, so a connected zen session
 *  points the CLI at cockpit's format proxy, which forwards upstream with the
 *  stored key. The key is stored as OPENCODE_API_KEY, never sent by the CLI. */
function buildOpenCodeZenProvider(stored: Provider | undefined): Provider {
  const key = stored?.envVars?.OPENCODE_API_KEY;
  const proxy = getActiveFormatProxy();
  // OPENCODE_API_KEY is always present when connected so the settings UI (which
  // runs in the Next.js module graph, where the proxy singleton may be absent)
  // can tell connected from not; the wire vars appear only where the proxy is
  // live, which is the graph that actually spawns sessions.
  return {
    id: OPENCODE_ZEN_PROVIDER_ID,
    name: "OpenCode Zen",
    envVars: key
      ? {
          OPENCODE_API_KEY: key,
          ...(proxy?.isRunning
            ? {
                ANTHROPIC_BASE_URL: proxy.getUrl(OPENCODE_ZEN_PROVIDER_ID),
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

/** Upstream config for the format proxy. Null when the provider is not
 *  connected (no key) — the proxy 404s those. */
export function resolveProxyUpstream(
  providerId: string,
): { baseUrl: string; apiKey: string; modelIds: string[]; wireFormat?: "openai" | "anthropic" } | null {
  if (providerId === OPENROUTER_PROVIDER_ID) {
    const stored = loadBuiltinStored(OPENROUTER_PROVIDER_ID);
    const apiKey = stored?.envVars?.ANTHROPIC_AUTH_TOKEN;
    if (!apiKey) return null;
    return { baseUrl: openRouterBaseUrl(), apiKey, modelIds: catalogModels().map((m) => m.modelId), wireFormat: "anthropic" };
  }
  if (providerId !== OPENCODE_ZEN_PROVIDER_ID) return null;
  const stored = loadBuiltinStored(OPENCODE_ZEN_PROVIDER_ID);
  const apiKey = stored?.envVars?.OPENCODE_API_KEY;
  if (!apiKey) return null;
  return { baseUrl: zenBaseUrl(), apiKey, modelIds: (stored?.models ?? []).map((m) => m.modelId) };
}

interface ModelsDevEntry {
  name?: string;
  cost?: { input?: number; output?: number };
  limit?: { context?: number };
  tool_call?: boolean;
  reasoning?: boolean;
  modalities?: { input?: string[] };
}

/** Pricing/capability metadata for zen models. Zen's own /models list is bare
 *  OpenAI shape, but models.dev (the OpenCode team's model database, which
 *  the zen docs pricing table is built from) carries cost per 1M, context
 *  windows, and capability flags under its "opencode" provider. Best-effort:
 *  a failed fetch degrades to the bare list. */
async function fetchZenModelMeta(): Promise<Record<string, ModelsDevEntry>> {
  try {
    const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return {};
    const body = (await res.json()) as { opencode?: { models?: Record<string, ModelsDevEntry> } };
    return body.opencode?.models ?? {};
  } catch {
    return {};
  }
}

/** Fetch zen's OpenAI-style model list with the stored (or given) key,
 *  enrich it from models.dev, and persist it on the builtin entry. Newly seen
 *  models join enabledModels so a fresh connect exposes the whole curated zen
 *  catalog in pickers. */
export async function syncZenModels(keyOverride?: string): Promise<{ ok: boolean; modelCount?: number; error?: string }> {
  const stored = loadBuiltinStored(OPENCODE_ZEN_PROVIDER_ID);
  const apiKey = keyOverride ?? stored?.envVars?.OPENCODE_API_KEY;
  if (!apiKey) return { ok: false, error: "OpenCode Zen is not connected" };
  try {
    const res = await fetch(`${zenBaseUrl()}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, error: `Zen models fetch failed: HTTP ${res.status}` };
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
    if (ids.length === 0) return { ok: false, error: "Zen models fetch returned no models" };

    const meta = await fetchZenModelMeta();
    // Free is zero cost when metadata exists (catches unsuffixed free models
    // like big-pickle); the "-free" id suffix is the fallback signal.
    const models: ProviderModel[] = ids.map((id) => {
      const m = meta[id];
      const free = m?.cost ? (m.cost.input ?? 0) === 0 && (m.cost.output ?? 0) === 0 : /-free$/.test(id);
      return {
        modelId: id,
        displayName: m?.name || id,
        effortLevels: [],
        contextSizes: [],
        contextLength: m?.limit?.context,
        pricing: m?.cost ? { inPerM: m.cost.input ?? 0, outPerM: m.cost.output ?? 0 } : undefined,
        free,
        supportsTools: m?.tool_call,
        supportsReasoning: m?.reasoning,
        supportsImageInput: m?.modalities?.input?.includes("image"),
      };
    });
    const prevEnabled = new Set(stored?.enabledModels ?? []);
    const enabledModels = stored ? ids.filter((id) => prevEnabled.size === 0 || prevEnabled.has(id)) : ids;
    saveBuiltinStored(OPENCODE_ZEN_PROVIDER_ID, {
      envVars: { ...stored?.envVars, OPENCODE_API_KEY: apiKey },
      models,
      enabledModels,
      syncedAt: Date.now(),
    });
    rebuildCache(loadCustom());
    return { ok: true, modelCount: models.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function rebuildCache(custom: Provider[]): void {
  cache = [
    buildAnthropicProvider(),
    buildOpenRouterProvider(loadBuiltinStored(OPENROUTER_PROVIDER_ID)),
    buildOpenCodeZenProvider(loadBuiltinStored(OPENCODE_ZEN_PROVIDER_ID)),
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
    return id === OPENROUTER_PROVIDER_ID ? buildOpenRouterProvider(entry) : buildOpenCodeZenProvider(entry);
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
