import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { toProviderModels } from "@/lib/models";
import { getCockpitDir } from "@/server/paths";
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

let cache: Provider[] | null = null;
// mtime of providers.json at the last load. Cockpit runs as two separate module
// graphs — the custom server (dist/, which spawns sessions) and the Next.js API
// routes (settings CRUD) — so a provider added/edited via settings only resets
// that graph's `cache`, never the spawner's, leaving new sessions on a stale list
// until restart. Gating the cache on the file mtime makes either graph (and a
// hand-edit of the file) reload when the file changes.
let cacheMtimeMs = 0;

function providersMtimeMs(): number {
  try {
    return statSync(providersFile()).mtimeMs;
  } catch {
    return 0; // file absent — no custom providers yet
  }
}

function loadCustom(): Provider[] {
  try {
    return JSON.parse(readFileSync(providersFile(), "utf-8"));
  } catch {
    return [];
  }
}

function saveCustom(providers: Provider[]): void {
  try {
    mkdirSync(prefsDir(), { recursive: true });
    writeFileSync(providersFile(), JSON.stringify(providers, null, 2) + "\n");
  } catch {
    // best effort
  }
}

export function getProviders(): Provider[] {
  const mtime = providersMtimeMs();
  if (cache === null || mtime !== cacheMtimeMs) {
    cache = [buildAnthropicProvider(), ...loadCustom()];
    cacheMtimeMs = mtime;
  }
  return cache;
}

export function getProvider(id: string): Provider | undefined {
  return getProviders().find((p) => p.id === id);
}

export function addProvider(provider: Omit<Provider, "id">): Provider {
  const newProvider: Provider = { ...provider, id: uuidv4() };
  validateProvider(newProvider);
  const all = getProviders();
  const custom = all.filter((p) => !p.isBuiltin);
  custom.push(newProvider);
  saveCustom(custom);
  cache = [buildAnthropicProvider(), ...custom];
  cacheMtimeMs = providersMtimeMs();
  return newProvider;
}

export function updateProvider(id: string, partial: Partial<Provider>): Provider {
  if (id === "anthropic") throw new Error("Cannot modify built-in provider");
  const all = getProviders();
  const custom = all.filter((p) => !p.isBuiltin);
  const idx = custom.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Provider not found: ${id}`);
  const merged = { ...custom[idx], ...partial, id };
  validateProvider(merged);
  custom[idx] = merged;
  saveCustom(custom);
  cache = [buildAnthropicProvider(), ...custom];
  cacheMtimeMs = providersMtimeMs();
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
  cacheMtimeMs = providersMtimeMs();
}

export function setProviders(providers: Provider[]): void {
  const custom = providers.filter((p) => !p.isBuiltin);
  for (const p of custom) validateProvider(p);
  saveCustom(custom);
  cache = [buildAnthropicProvider(), ...custom];
  cacheMtimeMs = providersMtimeMs();
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
