/**
 * Messages between the server and the telemetry worker, and the interface the
 * PTY runtime uses to give a spawn its telemetry. Types only.
 */

import type { TelemetryPage, TelemetryQuery, TelemetryStoreStats } from "@/types";
import type { DbOptions } from "./db";
import type { OtlpKind } from "./otlp";

export interface IngestMeta {
  sessionId: string;
  spawnId: string;
  kind: OtlpKind;
  receivedMs: number;
  gzip: boolean;
}

export interface WorkerInit {
  file: string;
  options?: DbOptions;
  /** Minutes between pruning passes. */
  pruneEveryMs?: number;
}

export type WorkerRequest =
  | { type: "ingest"; meta: IngestMeta; body: Uint8Array }
  | { type: "query"; id: number; query: TelemetryQuery }
  | { type: "stats"; id: number; sessionId?: string };

export type WorkerResponse =
  | { type: "ready"; available: true }
  | { type: "ready"; available: false; reason: string }
  | { type: "ack"; bytes: number; records: number; skipped: number; error?: string }
  | { type: "result"; id: number; result?: TelemetryPage | TelemetryStoreStats; error?: string };

/** What a spawn needs to send cockpit its telemetry. */
export interface TelemetrySpawn {
  token: string;
  spawnId: string;
}

/** How a spawn's settings file came out. */
export type TelemetryOutcome = { status: "applied" } | { status: "skipped"; source: string; key: string };

export interface TelemetrySpawner {
  /** A token for this spawn, or null when telemetry is off or cannot be stored. */
  beginSpawn(sessionId: string, cliSessionId: string): Promise<TelemetrySpawn | null>;
  /** Record how the spawn's settings came out; a skipped spawn's token is retired at once. */
  noteOutcome(token: string, outcome: TelemetryOutcome): void;
  /** The spawn is over. Its token keeps working for a short grace period, so
   *  the batch a dying CLI flushes on its way out still lands. */
  endSpawn(token: string, graceMs?: number): void;
}
