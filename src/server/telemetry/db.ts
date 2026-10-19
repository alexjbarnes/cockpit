/**
 * The telemetry database: one SQLite file in cockpit's directory, written and
 * read only by the telemetry worker (worker.ts), never on the server's main
 * thread. Synchronous, because node:sqlite is; the worker is what keeps that
 * off the thread serving terminals.
 *
 * Large strings (prompts, replies, tool input and output) are kept apart from
 * their record in `content`, so a size cap can drop the bulky text first and
 * keep the numbers (tokens, cost, latency) for the whole retention period.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import type { TelemetryPage, TelemetryQuery, TelemetryRecord, TelemetrySignal, TelemetrySource, TelemetryStoreStats } from "@/types";
import type { ParsedBatch } from "./otlp";
import type { SqliteModule } from "./sqlite";

export const SCHEMA_VERSION = 1;
export const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_CAP_BYTES = 2 * 1024 * 1024 * 1024;
/** Strings longer than this live in `content`. */
export const DEFAULT_INLINE_MAX = 4096;
const DEFAULT_CHUNK = 2000;
export const MAX_PAGE = 1000;
const DEFAULT_PAGE = 200;

export interface DbOptions {
  now?: () => number;
  maxAgeMs?: number;
  capBytes?: number;
  inlineMax?: number;
  /** Rows a single pruning step deletes, so no one step holds the worker long. */
  chunk?: number;
}

export interface IngestContext {
  sessionId: string;
  spawnId: string;
  receivedMs: number;
}

export interface PruneProgress {
  removedRecords: number;
  removedContent: number;
  removedSources: number;
  done: boolean;
}

/** A database this code must not touch: written by a newer cockpit. */
export class TelemetryDbError extends Error {}

type Row = Record<string, unknown>;
type Param = string | number | null;
type Statement = ReturnType<InstanceType<SqliteModule["DatabaseSync"]>["prepare"]>;

const SCHEMA = `
CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  digest TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  spawn_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  last_record_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_ms INTEGER NOT NULL,
  time_ms INTEGER NOT NULL,
  end_ms INTEGER,
  session_id TEXT NOT NULL,
  cli_session_id TEXT,
  signal TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL,
  trace_id TEXT,
  span_id TEXT,
  parent_span_id TEXT,
  prompt_id TEXT,
  source_id INTEGER NOT NULL,
  attrs TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX records_session_time ON records(session_id, time_ms);
CREATE INDEX records_name_time ON records(name, time_ms);
CREATE INDEX records_received ON records(received_ms);
CREATE INDEX records_trace ON records(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX records_prompt ON records(prompt_id) WHERE prompt_id IS NOT NULL;
CREATE TABLE content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  value TEXT NOT NULL
);
CREATE INDEX content_record ON content(record_id);
`;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Corruption SQLite reports on open or first read: SQLITE_CORRUPT, SQLITE_NOTADB. */
function isCorrupt(err: unknown): boolean {
  const code = (err as { errcode?: unknown })?.errcode;
  if (code === 11 || code === 26) return true;
  return /malformed|not a database/i.test(err instanceof Error ? err.message : String(err));
}

function moveAside(file: string, at: number): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(file + suffix)) renameSync(file + suffix, `${file}.corrupt-${at}${suffix}`);
  }
}

/** Replace strings over `max` with a `{ $content, len }` marker, collecting
 *  them to be stored apart. */
function splitContent(value: unknown, at: string, out: Array<[string, string]>, max: number): unknown {
  if (typeof value === "string") {
    if (value.length <= max) return value;
    out.push([at, value]);
    return { $content: at, len: value.length };
  }
  if (Array.isArray(value)) return value.map((v, i) => splitContent(v, `${at}.${i}`, out, max));
  if (isObject(value)) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) o[k] = splitContent(v, `${at}.${k}`, out, max);
    return o;
  }
  return value;
}

function isContentRef(v: unknown): v is { $content: string; len: number } {
  return isObject(v) && typeof v.$content === "string" && typeof v.len === "number";
}

function rehydrate(value: unknown, contents: Map<string, string>): unknown {
  if (isContentRef(value)) {
    const text = contents.get(value.$content);
    return text !== undefined ? text : { ...value, pruned: true };
  }
  if (Array.isArray(value)) return value.map((v) => rehydrate(v, contents));
  if (isObject(value)) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) o[k] = rehydrate(v, contents);
    return o;
  }
  return value;
}

function parseCursor(cursor: string | undefined): { time: number; id: number } | null {
  const m = cursor?.match(/^(\d+):(\d+)$/);
  return m ? { time: Number(m[1]), id: Number(m[2]) } : null;
}

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v ?? 0);
}

function parseJson(v: unknown): Record<string, unknown> {
  if (typeof v !== "string") return {};
  try {
    const parsed = JSON.parse(v);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export class TelemetryDb {
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly capBytes: number;
  private readonly inlineMax: number;
  private readonly chunk: number;
  private readonly statements = new Map<string, Statement>();
  /** Source digest → id, so a spawn's repeated resource costs one lookup. */
  private readonly sourceIds = new Map<string, number>();
  /** Set while the size cap is being brought back under, down to 90%. */
  private trimming = false;

  private constructor(
    private readonly db: InstanceType<SqliteModule["DatabaseSync"]>,
    readonly file: string,
    opts: DbOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.capBytes = opts.capBytes ?? DEFAULT_CAP_BYTES;
    this.inlineMax = opts.inlineMax ?? DEFAULT_INLINE_MAX;
    this.chunk = opts.chunk ?? DEFAULT_CHUNK;
  }

  /** Open (creating with owner-only permissions) and bring the schema up to
   *  date. A corrupt file is moved aside and a fresh one started; one written
   *  by a newer cockpit is refused rather than rewritten. */
  static open(file: string, sqlite: SqliteModule, opts: DbOptions = {}): TelemetryDb {
    try {
      return TelemetryDb.openOnce(file, sqlite, opts);
    } catch (err) {
      if (!isCorrupt(err)) throw err;
      moveAside(file, (opts.now ?? Date.now)());
      return TelemetryDb.openOnce(file, sqlite, opts);
    }
  }

  private static openOnce(file: string, sqlite: SqliteModule, opts: DbOptions): TelemetryDb {
    mkdirSync(path.dirname(file), { recursive: true });
    // Created before SQLite opens it, so the file and the -wal and -shm files
    // SQLite makes beside it (which copy its mode) are the owner's alone: it
    // holds the user's prompts and tool output.
    if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
    const db = new sqlite.DatabaseSync(file);
    try {
      const store = new TelemetryDb(db, file, opts);
      store.migrate();
      return store;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  private migrate(): void {
    const version = num(this.db.prepare("PRAGMA user_version").get()?.user_version);
    if (version > SCHEMA_VERSION) {
      throw new TelemetryDbError(`telemetry.db was written by a newer cockpit (schema ${version}; this one knows ${SCHEMA_VERSION})`);
    }
    if (version === 0) {
      // Only takes effect before the first table exists, which is why it is
      // here and not with the other pragmas.
      this.db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    }
    // Not WAL on a filesystem that cannot do it (some network mounts); SQLite
    // then keeps its rollback journal, which works, just slower.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_size_limit = 67108864");
    if (version < 1) {
      this.transaction(() => {
        this.db.exec(SCHEMA);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
  }

  close(): void {
    this.db.close();
  }

  private stmt(sql: string): Statement {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private all(sql: string, ...params: Param[]): Row[] {
    return this.stmt(sql).all(...params) as Row[];
  }

  private get(sql: string, ...params: Param[]): Row | undefined {
    return this.stmt(sql).get(...params) as Row | undefined;
  }

  private run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: num(r.changes), lastInsertRowid: num(r.lastInsertRowid) };
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private sourceId(ctx: IngestContext, source: { resource: Record<string, unknown>; scope: Record<string, unknown> }): number {
    const resource = JSON.stringify(source.resource);
    const scope = JSON.stringify(source.scope);
    const digest = createHash("sha256").update(`${ctx.sessionId}\n${ctx.spawnId}\n${resource}\n${scope}`).digest("hex");
    const cached = this.sourceIds.get(digest);
    if (cached !== undefined) return cached;
    this.run(
      "INSERT INTO sources (digest, session_id, spawn_id, resource, scope) VALUES (?, ?, ?, ?, ?) ON CONFLICT(digest) DO NOTHING",
      digest,
      ctx.sessionId,
      ctx.spawnId,
      resource,
      scope,
    );
    const id = num(this.get("SELECT id FROM sources WHERE digest = ?", digest)?.id);
    this.sourceIds.set(digest, id);
    return id;
  }

  /** Store a parsed batch in one transaction. Returns the records written. */
  ingest(ctx: IngestContext, batch: ParsedBatch): number {
    if (batch.records.length === 0) return 0;
    return this.transaction(() => {
      const sources = new Map<number, number>();
      const lastBySource = new Map<number, number>();
      for (const r of batch.records) {
        let sourceId = sources.get(r.source);
        if (sourceId === undefined) {
          sourceId = this.sourceId(ctx, batch.sources[r.source] ?? { resource: {}, scope: {} });
          sources.set(r.source, sourceId);
        }
        const parts: Array<[string, string]> = [];
        const attrs = splitContent(r.attrs, "attrs", parts, this.inlineMax);
        const detail = r.detail ? splitContent(r.detail, "detail", parts, this.inlineMax) : null;
        const { lastInsertRowid: id } = this.run(
          `INSERT INTO records (received_ms, time_ms, end_ms, session_id, cli_session_id, signal, name, value,
             trace_id, span_id, parent_span_id, prompt_id, source_id, attrs, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ctx.receivedMs,
          r.timeMs,
          r.endMs ?? null,
          ctx.sessionId,
          r.cliSessionId ?? null,
          r.signal,
          r.name,
          r.value ?? null,
          r.traceId ?? null,
          r.spanId ?? null,
          r.parentSpanId ?? null,
          r.promptId ?? null,
          sourceId,
          JSON.stringify(attrs),
          detail ? JSON.stringify(detail) : null,
        );
        for (const [at, value] of parts) this.run("INSERT INTO content (record_id, path, value) VALUES (?, ?, ?)", id, at, value);
        lastBySource.set(sourceId, id);
      }
      for (const [sourceId, id] of lastBySource) this.run("UPDATE sources SET last_record_id = ? WHERE id = ?", id, sourceId);
      return batch.records.length;
    });
  }

  query(q: TelemetryQuery): TelemetryPage {
    const where: string[] = [];
    const params: Param[] = [];
    const add = (clause: string, ...values: Param[]) => {
      where.push(clause);
      params.push(...values);
    };
    if (q.session) add("session_id = ?", q.session);
    if (q.cliSession) add("cli_session_id = ?", q.cliSession);
    if (q.signal) add("signal = ?", q.signal);
    if (q.name) add("name = ?", q.name);
    if (q.since !== undefined) add("time_ms >= ?", q.since);
    if (q.until !== undefined) add("time_ms <= ?", q.until);
    const ingestOrder = q.order === "ingest";
    if (ingestOrder) {
      if (q.after !== undefined) add("id > ?", q.after);
    } else {
      const c = parseCursor(q.cursor);
      if (c) add("(time_ms > ? OR (time_ms = ? AND id > ?))", c.time, c.time, c.id);
    }
    const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_PAGE), 1), MAX_PAGE);
    const rows = this.db
      .prepare(
        `SELECT * FROM records ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY ${ingestOrder ? "id" : "time_ms, id"} LIMIT ?`,
      )
      .all(...params, limit + 1) as Row[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit);

    const contents = new Map<number, Map<string, string>>();
    if (q.content === "inline" && page.length > 0) {
      const ids = page.map((r) => num(r.id));
      const found = this.db
        .prepare(`SELECT record_id, path, value FROM content WHERE record_id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as Row[];
      for (const c of found) {
        const rid = num(c.record_id);
        const m = contents.get(rid) ?? new Map<string, string>();
        m.set(String(c.path), String(c.value));
        contents.set(rid, m);
      }
    }

    const records: TelemetryRecord[] = page.map((r) => {
      const id = num(r.id);
      const own = contents.get(id) ?? new Map<string, string>();
      const attrs = parseJson(r.attrs);
      const detail = r.detail == null ? null : parseJson(r.detail);
      const inline = q.content === "inline";
      return {
        id,
        receivedMs: num(r.received_ms),
        timeMs: num(r.time_ms),
        endMs: r.end_ms == null ? null : num(r.end_ms),
        sessionId: String(r.session_id),
        cliSessionId: r.cli_session_id == null ? null : String(r.cli_session_id),
        signal: String(r.signal) as TelemetrySignal,
        name: String(r.name),
        value: r.value == null ? null : num(r.value),
        traceId: r.trace_id == null ? null : String(r.trace_id),
        spanId: r.span_id == null ? null : String(r.span_id),
        parentSpanId: r.parent_span_id == null ? null : String(r.parent_span_id),
        promptId: r.prompt_id == null ? null : String(r.prompt_id),
        sourceId: num(r.source_id),
        attrs: inline ? (rehydrate(attrs, own) as Record<string, unknown>) : attrs,
        detail: inline && detail ? (rehydrate(detail, own) as Record<string, unknown>) : detail,
      };
    });

    const sources: Record<string, TelemetrySource> = {};
    const sourceIds = [...new Set(records.map((r) => r.sourceId))];
    if (sourceIds.length > 0) {
      const found = this.db
        .prepare(`SELECT id, session_id, spawn_id, resource, scope FROM sources WHERE id IN (${sourceIds.map(() => "?").join(",")})`)
        .all(...sourceIds) as Row[];
      for (const s of found) {
        sources[String(num(s.id))] = {
          sessionId: String(s.session_id),
          spawnId: String(s.spawn_id),
          resource: parseJson(s.resource),
          scope: parseJson(s.scope),
        };
      }
    }

    const last = page[page.length - 1];
    const nextCursor = more && last ? (ingestOrder ? String(num(last.id)) : `${num(last.time_ms)}:${num(last.id)}`) : null;
    return { records, sources, nextCursor };
  }

  private pragma(name: string): number {
    return num(this.db.prepare(`PRAGMA ${name}`).get()?.[name]);
  }

  /** Bytes the data occupies: pages in use, not pages freed and not yet
   *  given back to the filesystem. */
  liveBytes(): number {
    return (this.pragma("page_count") - this.pragma("freelist_count")) * this.pragma("page_size");
  }

  stats(sessionId?: string): TelemetryStoreStats {
    const scoped = sessionId ? "WHERE session_id = ?" : "";
    const scope: Param[] = sessionId ? [sessionId] : [];
    const bySignal: Record<string, number> = {};
    let records = 0;
    for (const r of this.db.prepare(`SELECT signal, count(*) AS n FROM records ${scoped} GROUP BY signal`).all(...scope) as Row[]) {
      bySignal[String(r.signal)] = num(r.n);
      records += num(r.n);
    }
    let byName: Record<string, number> | undefined;
    if (sessionId) {
      byName = {};
      for (const r of this.all("SELECT name, count(*) AS n FROM records WHERE session_id = ? GROUP BY name", sessionId)) {
        byName[String(r.name)] = num(r.n);
      }
    }
    const span = this.get("SELECT min(received_ms) AS oldest, max(received_ms) AS newest FROM records");
    let walBytes = 0;
    try {
      walBytes = statSync(`${this.file}-wal`).size;
    } catch {
      // no WAL file (yet, or not in WAL mode)
    }
    return {
      records,
      bySignal,
      byName,
      sources: num(this.get("SELECT count(*) AS n FROM sources")?.n),
      contentRows: num(this.get("SELECT count(*) AS n FROM content")?.n),
      oldestMs: span?.oldest == null ? null : num(span.oldest),
      newestMs: span?.newest == null ? null : num(span.newest),
      dbBytes: this.pragma("page_count") * this.pragma("page_size"),
      walBytes,
    };
  }

  /** Delete one chunk of what retention says must go, oldest first. Call
   *  until `done`; the worker yields between calls so ingest is not held up. */
  pruneStep(): PruneProgress {
    const progress: PruneProgress = { removedRecords: 0, removedContent: 0, removedSources: 0, done: false };
    // Past the age limit, by when cockpit received it: the CLI's own clock
    // decides time_ms and cannot be trusted to decide what is deleted.
    const oldest = this.get("SELECT id FROM records WHERE received_ms < ? ORDER BY received_ms DESC LIMIT 1", this.now() - this.maxAgeMs);
    if (oldest) {
      Object.assign(progress, this.deleteOldestRecords(num(oldest.id)));
      return progress;
    }
    // Over the size cap: the bulky text goes first, the numbers only when
    // there is no text left to take.
    const target = this.trimming ? this.capBytes * 0.9 : this.capBytes;
    if (this.liveBytes() > target) {
      this.trimming = true;
      const content = this.all("SELECT id FROM content ORDER BY id LIMIT ?", this.chunk);
      if (content.length > 0) {
        progress.removedContent = this.run("DELETE FROM content WHERE id <= ?", num(content[content.length - 1].id)).changes;
        return progress;
      }
      const newest = this.get("SELECT max(id) AS id FROM records");
      if (newest?.id != null) {
        Object.assign(progress, this.deleteOldestRecords(num(newest.id)));
        return progress;
      }
    }
    this.trimming = false;
    // A source whose last record has gone has no records left: they are
    // deleted oldest first.
    progress.removedSources = this.run(
      "DELETE FROM sources WHERE last_record_id < (SELECT coalesce(min(id), 9007199254740991) FROM records)",
    ).changes;
    if (progress.removedSources > 0) this.sourceIds.clear();
    this.db.exec("PRAGMA incremental_vacuum");
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    progress.done = true;
    return progress;
  }

  /** Delete the oldest chunk of records with ids up to `upTo`, and their content. */
  private deleteOldestRecords(upTo: number): Pick<PruneProgress, "removedRecords" | "removedContent"> {
    const ids = this.all("SELECT id FROM records WHERE id <= ? ORDER BY id LIMIT ?", upTo, this.chunk);
    if (ids.length === 0) return { removedRecords: 0, removedContent: 0 };
    const last = num(ids[ids.length - 1].id);
    return this.transaction(() => ({
      removedContent: this.run("DELETE FROM content WHERE record_id <= ?", last).changes,
      removedRecords: this.run("DELETE FROM records WHERE id <= ?", last).changes,
    }));
  }

  /** Run every pruning step to the end. Tests and one-off callers. */
  prune(): PruneProgress {
    const total: PruneProgress = { removedRecords: 0, removedContent: 0, removedSources: 0, done: false };
    for (;;) {
      const step = this.pruneStep();
      total.removedRecords += step.removedRecords;
      total.removedContent += step.removedContent;
      total.removedSources += step.removedSources;
      if (step.done) return { ...total, done: true };
    }
  }
}
