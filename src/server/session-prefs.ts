import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ThinkingLevel } from "@/types";

export interface SessionPrefs {
  name?: string;
  thinkingLevel?: ThinkingLevel;
  bypassAllPermissions?: boolean;
  allowedTools?: string[];
  model?: string;
}

const PREFS_DIR = join(homedir(), ".aperture");
const PREFS_FILE = join(PREFS_DIR, "session-prefs.json");

let cache: Record<string, SessionPrefs> | null = null;

function load(): Record<string, SessionPrefs> {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(PREFS_FILE, "utf-8"));
    return cache!;
  } catch {
    cache = {};
    return cache;
  }
}

function save(): void {
  if (!cache) return;
  try {
    mkdirSync(PREFS_DIR, { recursive: true });
    writeFileSync(PREFS_FILE, JSON.stringify(cache, null, 2) + "\n");
  } catch {
    // best effort
  }
}

export function getSessionPrefs(sessionId: string): SessionPrefs | undefined {
  return load()[sessionId];
}

export function setSessionPrefs(sessionId: string, prefs: Partial<SessionPrefs>): void {
  const all = load();
  const existing = all[sessionId] || {};
  all[sessionId] = { ...existing, ...prefs };
  save();
}

export function deleteSessionPrefs(sessionId: string): void {
  const all = load();
  delete all[sessionId];
  save();
}
