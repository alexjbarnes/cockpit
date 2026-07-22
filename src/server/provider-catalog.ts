import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDefaults } from "@/server/defaults";
import { addInboxMessage } from "@/server/inbox";
import { loadJobs } from "@/server/job-storage";
import { getCockpitDir } from "@/server/paths";
import type { ProviderModel } from "@/types";

export const OPENROUTER_PROVIDER_ID = "openrouter";
// Test escape hatch: the integration harness points this at the mock API.
export function openRouterBaseUrl(): string {
  return process.env.COCKPIT_OPENROUTER_BASE_URL || "https://openrouter.ai/api";
}

const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PRE_SPAWN_STALE_MS = 24 * 60 * 60 * 1000;
// D8: badges never degrade; instead one alert fires when refreshes keep failing.
const ALERT_CONSECUTIVE_FAILURES = 3;
const ALERT_STALE_MS = 48 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

export interface CatalogState {
  syncedAt: number;
  consecutiveFailures: number;
  /** One D8 alert per failure episode; reset on the next successful sync. */
  failureAlerted?: boolean;
  models: ProviderModel[];
  /** Ids that were in a previous sync but are gone now — kept so slots and
   *  jobs pointing at them stay diagnosable instead of silently vanishing. */
  delisted: string[];
}

export interface CatalogChange {
  kind: "delisted" | "free-to-paid" | "price-changed";
  modelId: string;
  detail: string;
}

/** Raw OpenRouter /api/v1/models entry — only the fields cockpit maps. */
interface OpenRouterRawModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: Record<string, string | number | null | undefined>;
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  expiration_date?: string;
}

function catalogFile(): string {
  return join(getCockpitDir(), "provider-catalog.json");
}

let cache: CatalogState | null = null;
let cacheMtimeMs = -1;

function fileMtimeMs(): number {
  try {
    return statSync(catalogFile()).mtimeMs;
  } catch {
    return 0;
  }
}

export function loadCatalog(): CatalogState | null {
  const mtime = fileMtimeMs();
  if (cacheMtimeMs !== mtime) {
    try {
      cache = JSON.parse(readFileSync(catalogFile(), "utf-8"));
    } catch {
      cache = null;
    }
    cacheMtimeMs = mtime;
  }
  return cache;
}

function saveCatalog(state: CatalogState): void {
  writeFileSync(catalogFile(), JSON.stringify(state, null, 2) + "\n");
  cache = state;
  cacheMtimeMs = fileMtimeMs();
}

export function catalogModels(): ProviderModel[] {
  return loadCatalog()?.models ?? [];
}

export function hasCatalogModel(bareModelId: string): boolean {
  return catalogModels().some((m) => m.modelId === bareModelId);
}

const PER_TOKEN_TO_PER_M = 1e6;

/** Map one raw catalog entry to cockpit's ProviderModel. Returns null for
 *  entries cockpit cannot use (no text output). */
export function mapOpenRouterModel(raw: OpenRouterRawModel): ProviderModel | null {
  const out = raw.architecture?.output_modalities;
  if (out && !out.includes("text")) return null;
  const prompt = Number(raw.pricing?.prompt ?? 0);
  const completion = Number(raw.pricing?.completion ?? 0);
  // Zero prompt/completion alone is not "free": media-output models bill on
  // audio/image generation (sometimes without exposing it in this pricing
  // map), and "openrouter/*" ids are meta-routers with no price of their own.
  // The badge needs text-only output, no other nonzero pricing field, and a
  // non-meta id — or the provider's own :free marker.
  const otherPricing = Object.entries(raw.pricing ?? {}).some(
    ([field, value]) => field !== "prompt" && field !== "completion" && Number(value ?? 0) > 0,
  );
  const textOnlyOutput = !out || (out.length === 1 && out[0] === "text");
  const zeroPriced = prompt === 0 && completion === 0 && !otherPricing && textOnlyOutput;
  const free = raw.id.endsWith(":free") || (zeroPriced && !raw.id.startsWith("openrouter/"));
  const params = raw.supported_parameters ?? [];
  return {
    modelId: raw.id,
    displayName: raw.name || raw.id,
    effortLevels: [],
    contextSizes: [],
    contextLength: raw.context_length,
    pricing: { inPerM: prompt * PER_TOKEN_TO_PER_M, outPerM: completion * PER_TOKEN_TO_PER_M },
    free,
    supportsTools: params.includes("tools"),
    supportsReasoning: params.includes("reasoning"),
    supportsImageInput: (raw.architecture?.input_modalities ?? []).includes("image"),
    expirationDate: raw.expiration_date,
  };
}

export function computeCatalogDiff(prev: ProviderModel[], next: ProviderModel[]): CatalogChange[] {
  const changes: CatalogChange[] = [];
  const nextById = new Map(next.map((m) => [m.modelId, m]));
  for (const p of prev) {
    const n = nextById.get(p.modelId);
    if (!n) {
      changes.push({ kind: "delisted", modelId: p.modelId, detail: "no longer offered" });
      continue;
    }
    const pIn = p.pricing?.inPerM ?? 0;
    const pOut = p.pricing?.outPerM ?? 0;
    const nIn = n.pricing?.inPerM ?? 0;
    const nOut = n.pricing?.outPerM ?? 0;
    if (p.free && !n.free) {
      changes.push({ kind: "free-to-paid", modelId: p.modelId, detail: `free → $${nIn}/$${nOut} per M` });
    } else if (pIn !== nIn || pOut !== nOut) {
      changes.push({ kind: "price-changed", modelId: p.modelId, detail: `$${pIn}/$${pOut} → $${nIn}/$${nOut} per M` });
    }
  }
  return changes;
}

/** Bare model ids currently referenced by cockpit: the curated enabled set,
 *  the default model slots, and every scheduled job's model. Reads the
 *  openrouter entry straight from providers.json to avoid a module cycle
 *  with providers.ts. */
export function inUseOpenRouterModels(): Set<string> {
  const inUse = new Set<string>();
  try {
    const providers: Array<{ id?: string; enabledModels?: string[] }> = JSON.parse(
      readFileSync(join(getCockpitDir(), "providers.json"), "utf-8"),
    );
    const or = providers.find((p) => p.id === OPENROUTER_PROVIDER_ID);
    for (const id of or?.enabledModels ?? []) inUse.add(id);
  } catch {
    // no providers.json yet
  }
  const stripPrefix = (id: string | undefined) => {
    if (!id) return;
    if (id.startsWith(`${OPENROUTER_PROVIDER_ID}:`)) inUse.add(id.slice(OPENROUTER_PROVIDER_ID.length + 1));
  };
  const slots = getDefaults().modelSlots;
  stripPrefix(slots.main);
  stripPrefix(slots.subagent);
  stripPrefix(slots.fast);
  for (const job of loadJobs()) stripPrefix(job.model);
  return inUse;
}

/** W6j: a job on a catalog-backed model that is missing from the catalog must
 *  fail before the CLI spawns. Only judges openrouter-qualified ids, and only
 *  once a catalog exists — an unsynced install never fails jobs over it. */
export function checkJobModel(model: string | undefined): { ok: true } | { ok: false; reason: string } {
  if (!model || !model.startsWith(`${OPENROUTER_PROVIDER_ID}:`)) return { ok: true };
  const catalog = loadCatalog();
  if (!catalog) return { ok: true };
  const bare = model.slice(OPENROUTER_PROVIDER_ID.length + 1).replace(/\[.*\]$/, "");
  if (catalog.models.some((m) => m.modelId === bare)) return { ok: true };
  const delisted = catalog.delisted.includes(bare);
  return {
    ok: false,
    reason: `Model ${model} is ${delisted ? "no longer offered by OpenRouter" : "not in the OpenRouter catalog"}. Pick a new model for this job; it will not run until you do.`,
  };
}

export async function syncOpenRouterCatalog(): Promise<{ ok: boolean; modelCount?: number; changes?: CatalogChange[]; error?: string }> {
  const prev = loadCatalog();
  try {
    const res = await fetch(`${openRouterBaseUrl()}/v1/models`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: OpenRouterRawModel[] };
    if (!Array.isArray(body.data) || body.data.length === 0) throw new Error("catalog fetch returned no models");

    const models = body.data.map(mapOpenRouterModel).filter((m): m is ProviderModel => m !== null);
    const changes = prev ? computeCatalogDiff(prev.models, models) : [];
    const nextIds = new Set(models.map((m) => m.modelId));
    const delisted = new Set(prev?.delisted.filter((id) => !nextIds.has(id)) ?? []);
    for (const c of changes) if (c.kind === "delisted") delisted.add(c.modelId);

    saveCatalog({ syncedAt: Date.now(), consecutiveFailures: 0, models, delisted: [...delisted] });
    notifyRelevantChanges(changes);
    return { ok: true, modelCount: models.length, changes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSyncFailure(prev, message);
    return { ok: false, error: message };
  }
}

/** D9: alert only when a change touches something actually in use. */
function notifyRelevantChanges(changes: CatalogChange[]): void {
  if (changes.length === 0) return;
  const inUse = inUseOpenRouterModels();
  const relevant = changes.filter((c) => inUse.has(c.modelId));
  if (relevant.length === 0) return;
  const lines = relevant.map((c) => `- ${c.modelId}: ${c.detail}`);
  addInboxMessage({
    title: `OpenRouter catalog: ${relevant.length} change${relevant.length === 1 ? "" : "s"} affecting your models`,
    body: lines.join("\n"),
    priority: "warning",
  });
}

function recordSyncFailure(prev: CatalogState | null, message: string): void {
  const state: CatalogState = prev ?? { syncedAt: 0, consecutiveFailures: 0, models: [], delisted: [] };
  const failures = state.consecutiveFailures + 1;
  const stale = state.syncedAt > 0 && Date.now() - state.syncedAt > ALERT_STALE_MS;
  let alerted = state.failureAlerted ?? false;
  if (!alerted && (failures >= ALERT_CONSECUTIVE_FAILURES || stale)) {
    const last = state.syncedAt > 0 ? new Date(state.syncedAt).toISOString() : "never";
    addInboxMessage({
      title: "OpenRouter catalog refresh is failing",
      body: `${failures} consecutive failed refresh${failures === 1 ? "" : "es"} (last success: ${last}). Latest error: ${message}. Model pricing and availability may be stale.`,
      priority: "warning",
    });
    alerted = true;
  }
  saveCatalog({ ...state, consecutiveFailures: failures, failureAlerted: alerted });
}

/** Pre-spawn revalidation: fire-and-forget resync when the cache is old. */
export function ensureCatalogFresh(): void {
  const catalog = loadCatalog();
  if (catalog && Date.now() - catalog.syncedAt < PRE_SPAWN_STALE_MS) return;
  void syncOpenRouterCatalog();
}

let syncTimer: ReturnType<typeof setInterval> | null = null;

/** Boot-time sync plus a daily refresh. Idempotent. */
export function startCatalogSync(): void {
  if (syncTimer) return;
  void syncOpenRouterCatalog();
  syncTimer = setInterval(() => void syncOpenRouterCatalog(), SYNC_INTERVAL_MS);
  syncTimer.unref?.();
}
