import { readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ContextSize } from "@/lib/models";
import { splitLegacyModel } from "@/lib/models";
import { writeJsonAtomic } from "@/server/atomic-write";
import { getCockpitDir } from "@/server/paths";
import type { InitData, ModelSlots, SandboxConfig, SessionPermissionMode, ThinkingLevel } from "@/types";

export type SessionRuntime = "stream" | "pty";

export interface PersistedTab {
  type: "file" | "diff" | "changes";
  filePath?: string;
}

export interface SessionPrefs {
  name?: string;
  thinkingLevel?: ThinkingLevel;
  /** Legacy: superseded by permissionMode. Still read when migrating an old
   *  prefs file (true → "bypass"), never written. */
  bypassAllPermissions?: boolean;
  permissionMode?: SessionPermissionMode;
  sandbox?: SandboxConfig;
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
/** What the file looked like when `cache` was filled. See stamp(). */
let cacheStamp: string | null = null;

/**
 * Identity of the prefs file on disk right now, or null when that can't be
 * established.
 *
 * This module is compiled into two separate bundles that both load into the one
 * server process: dist/src/server/session-prefs.js for the custom server
 * (session-manager, ws-handler, transcript) and a Next chunk for the route
 * handlers under /api/sessions/[id]/. Each therefore has its own `cache`, and
 * since save() rewrites the whole file from it, a cache held from process start
 * was a time bomb: opening a file tab (Next side) wrote its stale snapshot back
 * over the rename and model change the WS side had made hours earlier. Comparing
 * this stamp before trusting the cache is what makes the two copies converge —
 * whoever writes bumps mtime, and the other reloads on its next read.
 *
 * A null stamp means "can't tell", which deliberately forces a re-read rather
 * than trusting a cache that might be stale.
 */
function stamp(): string | null {
  try {
    const st = statSync(prefsFile());
    return `${st.mtimeMs}:${st.size}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return "absent";
    return null;
  }
}

function load(): Record<string, SessionPrefs> {
  const current = stamp();
  if (cache && current !== null && current === cacheStamp) return cache;
  cacheStamp = current;
  // Refill the same object rather than replacing it, so a reference a caller is
  // already holding stays the live map. A reload that swapped `cache` for a new
  // object would silently drop whatever the caller then wrote into the old one.
  if (!cache) cache = {};
  const target = cache;
  for (const k of Object.keys(target)) delete target[k];
  try {
    Object.assign(target, JSON.parse(readFileSync(prefsFile(), "utf-8")));
    return target;
  } catch (err) {
    // ENOENT (no prefs file yet) is normal on first run. Anything else means
    // the file exists but didn't parse — every session's model/thinking/
    // context would otherwise silently reset to defaults, so this is loud,
    // and the unreadable file is preserved for recovery instead of getting
    // overwritten by the next save() with a freshly emptied cache.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[session-prefs] ${prefsFile()} failed to parse, starting empty and preserving the file for recovery:`, err);
      try {
        renameSync(prefsFile(), `${prefsFile()}.corrupted-${Date.now()}`);
      } catch {
        // best effort
      }
    }
    return target;
  }
}

function save(): void {
  if (!cache) return;
  try {
    // Atomic write (write-then-rename, see atomic-write.ts): a process killed
    // mid-write can never leave prefsFile() holding truncated JSON that wipes
    // every session's settings on the next load().
    writeJsonAtomic(prefsFile(), cache);
    // Re-stamp from the file we just wrote, so our own save doesn't look like
    // someone else's change and force a pointless re-read.
    cacheStamp = stamp();
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
  const chain = findChainIn(all, sessionId);
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
    const chain = findChainIn(all, sessionId);
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
  return findChainIn(load(), targetCliId);
}

/**
 * Chain lookup against an already-loaded map. Callers that hold a map pass it in
 * so one public call means one load() — resolving the chain through the public
 * entry point instead would re-enter load() and, if the file had changed in
 * between, re-read it half way through a read-modify-write.
 */
function findChainIn(all: Record<string, SessionPrefs>, targetCliId: string): { cockpitId: string; truncatedPrevIds: string[] } | null {
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
