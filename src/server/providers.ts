import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { toProviderModels } from "@/lib/models";
import { getCockpitDir } from "@/server/paths";
import { catalogModels, OPENROUTER_PROVIDER_ID, openRouterBaseUrl } from "@/server/provider-catalog";
import type { Provider, ProviderModel } from "@/types";

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
    envVars: key
      ? {
          ...stored?.envVars,
          ANTHROPIC_BASE_URL: openRouterBaseUrl(),
          ANTHROPIC_AUTH_TOKEN: key,
          ANTHROPIC_API_KEY: "",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        }
      : {},
    models: catalogModels(),
    isBuiltin: true,
    enabledModels: stored?.enabledModels ?? [],
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
  return loadStored().filter((p) => p.id !== OPENROUTER_PROVIDER_ID);
}

function loadOpenRouterStored(): Provider | undefined {
  return loadStored().find((p) => p.id === OPENROUTER_PROVIDER_ID);
}

/** Persist openrouter user state (key, enabled set) as an entry in
 *  providers.json alongside the custom providers. */
function saveOpenRouterStored(partial: Partial<Provider>): Provider {
  const prev = loadOpenRouterStored();
  const entry: Provider = {
    id: OPENROUTER_PROVIDER_ID,
    name: "OpenRouter",
    isBuiltin: true,
    models: [],
    envVars: partial.envVars ?? prev?.envVars ?? {},
    enabledModels: partial.enabledModels ?? prev?.enabledModels ?? [],
  };
  saveCustom(loadCustom(), entry);
  return entry;
}

function saveCustom(providers: Provider[], openRouterEntry?: Provider): void {
  try {
    mkdirSync(prefsDir(), { recursive: true });
    const or = openRouterEntry ?? loadOpenRouterStored();
    const all = or ? [or, ...providers] : providers;
    writeFileSync(providersFile(), JSON.stringify(all, null, 2) + "\n");
  } catch {
    // best effort
  }
}

function rebuildCache(custom: Provider[]): void {
  cache = [buildAnthropicProvider(), buildOpenRouterProvider(loadOpenRouterStored()), ...custom];
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
  // The openrouter built-in accepts only its user state: the key (envVars) and
  // the curated enabled set. Its models are catalog-synced, never hand-edited,
  // so the contextSizes validation for manual models does not apply.
  if (id === OPENROUTER_PROVIDER_ID) {
    const entry = saveOpenRouterStored({ envVars: partial.envVars, enabledModels: partial.enabledModels });
    rebuildCache(loadCustom());
    return buildOpenRouterProvider(entry);
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
  if (id === "anthropic" || id === OPENROUTER_PROVIDER_ID) throw new Error("Cannot delete built-in provider");
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
