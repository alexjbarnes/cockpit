/**
 * Cockpit's OpenTelemetry receiver: gives each CLI spawn a token, takes what
 * the spawn sends on the hook router's /otel routes, and hands it to the
 * store's worker. Everything here is cheap on the main thread: a token lookup
 * and reading the body, never parsing it.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TelemetryPage, TelemetryQuery, TelemetryStats } from "@/types";
import { TELEMETRY_TOKEN_HEADER } from "./env";
import type { OtlpKind } from "./otlp";
import type { TelemetryOutcome, TelemetrySpawn, TelemetrySpawner, WorkerInit } from "./protocol";
import { loadSqlite, type SqliteLoad } from "./sqlite";
import { type StoreLike, TelemetryStoreClient } from "./store-client";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const GRACE_MS = 60_000;

export interface TelemetryServiceOptions {
  dbFile: string;
  isEnabled: () => boolean;
  startStore?: (init: WorkerInit) => Promise<StoreLike>;
  /** Whether SQLite can load at all, asked without starting the store. */
  probe?: () => SqliteLoad;
  now?: () => number;
  maxBodyBytes?: number;
  graceMs?: number;
}

interface SpawnEntry {
  sessionId: string;
  spawnId: string;
  expiresAt: number;
}

type BodyResult = Uint8Array | "oversize" | "aborted";

async function readBody(req: IncomingMessage, max: number): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > max) return "oversize";
      chunks.push(buf);
    }
  } catch {
    return "aborted";
  }
  // A fresh buffer of exactly this size: it is transferred to the worker, and
  // a small Buffer can be a slice of Node's shared pool.
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function reply(res: ServerResponse, status: number, opts: { close?: boolean; retryAfter?: number } = {}): void {
  if (res.headersSent) return;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // An answer given without reading the body: close the connection, or the
  // unread body would be taken for the next request.
  if (opts.close) headers.Connection = "close";
  if (opts.retryAfter !== undefined) headers["Retry-After"] = String(opts.retryAfter);
  res.writeHead(status, headers);
  res.end(status < 300 || status === 429 ? "{}" : "");
}

export class TelemetryService implements TelemetrySpawner {
  private readonly dbFile: string;
  private readonly isEnabled: () => boolean;
  private readonly startStore: (init: WorkerInit) => Promise<StoreLike>;
  private readonly probe: () => SqliteLoad;
  private readonly now: () => number;
  private readonly maxBodyBytes: number;
  private readonly graceMs: number;
  private store: StoreLike | null = null;
  private storeStarting: Promise<StoreLike> | null = null;
  private probed: SqliteLoad | null = null;
  private readonly spawns = new Map<string, SpawnEntry>();
  private readonly spawnCounts = { applied: 0, skipped: 0, off: 0 };
  private readonly dropped = { disabled: 0, unknownToken: 0, unsupportedType: 0, oversize: 0, queueFull: 0, unavailable: 0 };
  private lastSkip: TelemetryStats["lastSkip"];
  private readonly loggedSkips = new Set<string>();

  constructor(opts: TelemetryServiceOptions) {
    this.dbFile = opts.dbFile;
    this.isEnabled = opts.isEnabled;
    this.startStore = opts.startStore ?? ((init) => TelemetryStoreClient.start(init));
    this.probe = opts.probe ?? (() => loadSqlite());
    this.now = opts.now ?? Date.now;
    this.maxBodyBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;
    this.graceMs = opts.graceMs ?? GRACE_MS;
  }

  /** The store, started on first need: nothing is created for a user who
   *  never switches telemetry on. */
  private ensureStore(): Promise<StoreLike> {
    if (this.store) return Promise.resolve(this.store);
    this.storeStarting ??= this.startStore({ file: this.dbFile }).then((store) => {
      this.store = store;
      console.log(store.available ? `[telemetry] storing in ${this.dbFile}` : `[telemetry] unavailable: ${store.reason}`);
      return store;
    });
    return this.storeStarting;
  }

  /** For reading: the store if it is running or has something to read. */
  private async readableStore(): Promise<StoreLike | null> {
    if (this.store) return this.store;
    if (this.storeStarting || this.isEnabled() || existsSync(this.dbFile)) return this.ensureStore();
    return null;
  }

  private lookup(token: string): SpawnEntry | undefined {
    const entry = this.spawns.get(token);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.spawns.delete(token);
      return undefined;
    }
    return entry;
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.spawns) if (entry.expiresAt <= now) this.spawns.delete(token);
  }

  async beginSpawn(sessionId: string, _cliSessionId: string): Promise<TelemetrySpawn | null> {
    if (!this.isEnabled()) {
      this.spawnCounts.off++;
      return null;
    }
    const store = await this.ensureStore();
    if (!store.available) {
      this.spawnCounts.off++;
      return null;
    }
    this.sweep();
    const spawn = { token: randomBytes(24).toString("hex"), spawnId: randomUUID() };
    this.spawns.set(spawn.token, { sessionId, spawnId: spawn.spawnId, expiresAt: Number.POSITIVE_INFINITY });
    return spawn;
  }

  noteOutcome(token: string, outcome: TelemetryOutcome): void {
    const entry = this.spawns.get(token);
    if (outcome.status === "applied") {
      this.spawnCounts.applied++;
      return;
    }
    this.spawnCounts.skipped++;
    if (entry) this.lastSkip = { sessionId: entry.sessionId, source: outcome.source, key: outcome.key, at: this.now() };
    const why = `${outcome.source}: ${outcome.key}`;
    if (!this.loggedSkips.has(why)) {
      this.loggedSkips.add(why);
      console.log(`[telemetry] leaving sessions' telemetry alone: ${outcome.key} is set in ${outcome.source}`);
    }
    this.endSpawn(token, 0);
  }

  endSpawn(token: string, graceMs = this.graceMs): void {
    const entry = this.spawns.get(token);
    if (!entry) return;
    if (graceMs <= 0) this.spawns.delete(token);
    else entry.expiresAt = Math.min(entry.expiresAt, this.now() + graceMs);
  }

  /** POST /otel/v1/{metrics,logs,traces}. Never answers 5xx: an exporter
   *  retries those, and a store that cannot keep up is answered 429 instead. */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = (req.url ?? "").match(/^\/otel\/v1\/(metrics|logs|traces)\/?(?:\?.*)?$/);
    if (!match) return reply(res, 404, { close: true });
    if (req.method !== "POST") return reply(res, 405, { close: true });
    const header = req.headers[TELEMETRY_TOKEN_HEADER];
    const entry = typeof header === "string" ? this.lookup(header) : undefined;
    if (!entry) {
      this.dropped.unknownToken++;
      return reply(res, 403, { close: true });
    }
    // Both OTLP encodings over HTTP: cockpit asks for protobuf, and managed
    // settings can pin either, overriding what cockpit asks for.
    const type = String(req.headers["content-type"] ?? "");
    const encoding = /^application\/json\b/i.test(type) ? "json" : /^application\/(x-)?protobuf\b/i.test(type) ? "protobuf" : null;
    if (!encoding) {
      this.dropped.unsupportedType++;
      return reply(res, 415, { close: true });
    }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      this.dropped.oversize++;
      return reply(res, 413, { close: true });
    }
    const body = await readBody(req, this.maxBodyBytes);
    if (body === "aborted") return;
    if (body === "oversize") {
      this.dropped.oversize++;
      return reply(res, 413, { close: true });
    }
    if (!this.isEnabled()) {
      this.dropped.disabled++;
      return reply(res, 200);
    }
    const store = this.store;
    const result = store
      ? store.ingest(
          {
            sessionId: entry.sessionId,
            spawnId: entry.spawnId,
            kind: match[1] as OtlpKind,
            receivedMs: this.now(),
            gzip: /gzip/i.test(String(req.headers["content-encoding"] ?? "")),
            encoding,
          },
          body,
        )
      : "unavailable";
    if (result === "full") {
      this.dropped.queueFull++;
      return reply(res, 429, { retryAfter: 2 });
    }
    if (result === "unavailable") this.dropped.unavailable++;
    reply(res, 200);
  }

  async query(q: TelemetryQuery): Promise<TelemetryPage> {
    const store = await this.readableStore();
    if (!store?.available) return { records: [], sources: {}, nextCursor: null };
    return store.query(q);
  }

  async stats(sessionId?: string): Promise<TelemetryStats> {
    const store = await this.readableStore();
    let available: boolean;
    let reason: string | undefined;
    if (store) {
      available = store.available;
      reason = store.reason;
    } else {
      this.probed ??= this.probe();
      available = !!this.probed.sqlite;
      reason = this.probed.reason;
    }
    let storeStats: TelemetryStats["store"] = null;
    if (store?.available) {
      try {
        storeStats = await store.stats(sessionId);
      } catch {
        // the worker is gone or slow; the counters below still say something
      }
    }
    return {
      available,
      ...(reason ? { reason } : {}),
      enabled: this.isEnabled(),
      spawns: { ...this.spawnCounts },
      ...(this.lastSkip ? { lastSkip: this.lastSkip } : {}),
      dropped: { ...this.dropped },
      ingest: {
        batches: store?.counters.batches ?? 0,
        records: store?.counters.records ?? 0,
        skipped: store?.counters.skipped ?? 0,
        failed: store?.counters.failed ?? 0,
        pendingBytes: store?.pendingBytes ?? 0,
        ...(store?.counters.lastError ? { lastError: store.counters.lastError } : {}),
      },
      store: storeStats,
    };
  }
}
