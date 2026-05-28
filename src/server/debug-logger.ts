import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { getCockpitDir } from "@/server/paths";
import type { ClientMessage, ServerMessage } from "@/types";
import type { ParsedEvent } from "./event-parser";

const enabled = process.env.COCKPIT_DEBUG === "1";
const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const CHECK_INTERVAL = 500; // check size every N writes

let logPath: string | null = null;
let prevPath: string | null = null;
let ready: Promise<void> | null = null;
let writeCount = 0;
let rotating = false;

function init(): Promise<void> {
  if (ready) return ready;
  const dir = getCockpitDir();
  logPath = path.join(dir, "debug.jsonl");
  prevPath = path.join(dir, "debug.prev.jsonl");
  ready = mkdir(dir, { recursive: true }).then(() => {});
  return ready;
}

function maybeRotate(): void {
  if (!logPath || !prevPath || rotating) return;
  writeCount++;
  if (writeCount % CHECK_INTERVAL !== 0) return;
  rotating = true;
  stat(logPath)
    .then((s) => {
      if (s.size > MAX_SIZE_BYTES) {
        return rename(logPath!, prevPath!);
      }
    })
    .catch(() => {})
    .finally(() => {
      rotating = false;
    });
}

function write(entry: Record<string, unknown>): void {
  if (!enabled || !logPath) return;
  const line = JSON.stringify({ ts: Date.now(), ...entry }) + "\n";
  appendFile(logPath, line).catch(() => {});
  maybeRotate();
}

/** Log a raw CLI stdout line before parsing */
export function logRawLine(sessionId: string, line: string): void {
  if (!enabled) return;
  init().then(() => write({ dir: "raw", sessionId, raw: line }));
}

/** Log a raw ParsedEvent from the session manager */
export function logParsedEvent(sessionId: string, event: ParsedEvent): void {
  if (!enabled) return;
  init().then(() => write({ dir: "event", sessionId, ...event }));
}

/** Log a ServerMessage sent to a client */
export function logServerMessage(msg: ServerMessage): void {
  if (!enabled) return;
  init().then(() => write({ dir: "out", ...msg }));
}

/** Log a ClientMessage received from a client */
export function logClientMessage(msg: ClientMessage): void {
  if (!enabled) return;
  init().then(() => write({ dir: "in", ...(msg as Record<string, unknown>) }));
}

/** Log session status changes */
export function logStatus(sessionId: string, status: string): void {
  if (!enabled) return;
  init().then(() => write({ dir: "status", sessionId, status }));
}

/** Log a diagnostic event with a label and arbitrary data */
export function logDiag(sessionId: string, label: string, data?: Record<string, unknown>): void {
  if (!enabled) return;
  init().then(() => write({ dir: "diag", sessionId, label, ...data }));
}

export function isDebugEnabled(): boolean {
  return enabled;
}

/** console.log gated by COCKPIT_DEBUG=1. Use for diagnostic stdout. */
export function debugLog(...args: unknown[]): void {
  if (!enabled) return;
  console.log(...args);
}
