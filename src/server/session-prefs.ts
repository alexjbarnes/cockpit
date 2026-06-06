import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextSize } from "@/lib/models";
import { splitLegacyModel } from "@/lib/models";
import { getCockpitDir } from "@/server/paths";
import type { InitData, ModelSlots, ThinkingLevel } from "@/types";

export type SessionRuntime = "stream" | "pty";

export interface PersistedTab {
  type: "file" | "diff" | "changes";
  filePath?: string;
}

export interface SessionPrefs {
  name?: string;
  thinkingLevel?: ThinkingLevel;
  bypassAllPermissions?: boolean;
  planMode?: boolean;
  model?: string;
  contextSize?: ContextSize;
  modelSlots?: ModelSlots;
  initData?: InitData;
  cliSessionId?: string;
  previousCliSessionIds?: string[];
  openTabs?: PersistedTab[];
  activeTabId?: string;
  runtime?: SessionRuntime;
  cockpitAgent?: boolean;
}

function prefsDir(): string {
  return getCockpitDir();
}
function prefsFile(): string {
  return join(prefsDir(), "session-prefs.json");
}

let cache: Record<string, SessionPrefs> | null = null;

function load(): Record<string, SessionPrefs> {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(prefsFile(), "utf-8"));
    return cache!;
  } catch {
    cache = {};
    return cache;
  }
}

function save(): void {
  if (!cache) return;
  try {
    mkdirSync(prefsDir(), { recursive: true });
    writeFileSync(prefsFile(), JSON.stringify(cache, null, 2) + "\n");
  } catch {
    // best effort
  }
}

function normalize(raw: SessionPrefs | undefined): SessionPrefs | undefined {
  if (!raw) return raw;
  const next = { ...raw };
  if (next.model?.includes("[")) {
    const split = splitLegacyModel(next.model);
    next.model = split.model;
    if (next.contextSize === undefined) next.contextSize = split.contextSize;
  }
  if (next.modelSlots?.main?.includes("[")) {
    const split = splitLegacyModel(next.modelSlots.main);
    next.modelSlots = {
      ...next.modelSlots,
      main: split.model,
      mainContext: next.modelSlots.mainContext ?? split.contextSize,
    };
  }
  return next;
}

export function getSessionPrefs(sessionId: string): SessionPrefs | undefined {
  const all = load();
  // Prefer chain resolution. The sidebar lists entries keyed by CLI id (one
  // per transcript on disk), so navigating to a /cleared chain member should
  // pick up the canonical cockpit-keyed prefs. Checking chain first also
  // guards against legacy CLI-id duplicates that may exist in the prefs file
  // from before chain resolution was applied at write time.
  const chain = findChainForCliSession(sessionId);
  if (chain && all[chain.cockpitId]) return normalize(all[chain.cockpitId]);
  return normalize(all[sessionId]);
}

export function setSessionPrefs(sessionId: string, prefs: Partial<SessionPrefs>): void {
  const all = load();
  let key = sessionId;
  // If sessionId isn't already a known cockpit-id key, check whether it's a
  // CLI id in an existing chain and write under the cockpit id instead. This
  // prevents per-CLI-id duplicate entries from accumulating in the prefs file
  // when users navigate via sidebar links (which use CLI ids).
  if (!all[sessionId]) {
    const chain = findChainForCliSession(sessionId);
    if (chain && all[chain.cockpitId]) key = chain.cockpitId;
  }
  const existing = all[key] || {};
  all[key] = { ...existing, ...prefs };
  save();
}

export function deleteSessionPrefs(sessionId: string): void {
  const all = load();
  delete all[sessionId];
  save();
}

export function findChainForCliSession(targetCliId: string): { cockpitId: string; truncatedPrevIds: string[] } | null {
  const all = load();
  for (const [cockpitId, prefs] of Object.entries(all)) {
    if (!prefs.previousCliSessionIds || !prefs.cliSessionId) continue;

    if (prefs.cliSessionId === targetCliId) {
      return { cockpitId, truncatedPrevIds: [...prefs.previousCliSessionIds] };
    }

    const idx = prefs.previousCliSessionIds.indexOf(targetCliId);
    if (idx >= 0) {
      return { cockpitId, truncatedPrevIds: prefs.previousCliSessionIds.slice(0, idx) };
    }
  }
  return null;
}
