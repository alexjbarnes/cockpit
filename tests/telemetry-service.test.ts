// The OpenTelemetry receiver on a real hook router, with a fake store: who
// may send, what is accepted, and what is dropped and counted.
import { request } from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { HookRouter } from "@/server/hook-router";
import type { IngestMeta, WorkerInit } from "@/server/telemetry/protocol";
import { TelemetryService } from "@/server/telemetry/service";
import type { IngestResult, StoreLike } from "@/server/telemetry/store-client";

class FakeStore implements StoreLike {
  available = true;
  reason: string | undefined;
  pendingBytes = 0;
  counters = { batches: 2, records: 5, skipped: 0, failed: 1, lastError: "bad json" };
  next: IngestResult = "queued";
  received: { meta: IngestMeta; body: Uint8Array }[] = [];
  statsError = false;
  ingest(meta: IngestMeta, body: Uint8Array): IngestResult {
    this.received.push({ meta, body });
    return this.next;
  }
  async query() {
    return { records: [], sources: {}, nextCursor: "next" };
  }
  async stats() {
    if (this.statsError) throw new Error("slow");
    return { records: 5, bySignal: { log: 5 }, sources: 1, contentRows: 0, oldestMs: 1, newestMs: 2, dbBytes: 4096, walBytes: 0 };
  }
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function post(
  url: string,
  opts: { path?: string; method?: string; headers?: Record<string, string>; body?: Buffer | string; chunked?: boolean } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = opts.body ?? "{}";
    const req = request(
      `${url}${opts.path ?? "/otel/v1/logs"}`,
      { method: opts.method ?? "POST", headers: { "content-type": "application/json", ...opts.headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    if (opts.chunked) {
      // No content-length: the size is only known by reading.
      req.setHeader("transfer-encoding", "chunked");
      req.write(body);
      req.end();
    } else req.end(body);
  });
}

describe("TelemetryService", () => {
  const router = new HookRouter();
  let url: string;
  let store: FakeStore;
  let enabled: boolean;
  let now: number;
  let service: TelemetryService;
  let startStore: Mock<(init: WorkerInit) => Promise<StoreLike>>;

  beforeAll(async () => {
    const addr = await router.start();
    url = `http://${addr.host}:${addr.port}`;
  });
  afterAll(() => router.stop());

  beforeEach(() => {
    store = new FakeStore();
    enabled = true;
    now = 1_000_000;
    startStore = vi.fn(async (_init: WorkerInit): Promise<StoreLike> => store);
    service = new TelemetryService({
      dbFile: "/nonexistent/telemetry.db",
      isEnabled: () => enabled,
      startStore,
      probe: () => ({ sqlite: null, reason: "probe says no" }),
      now: () => now,
      maxBodyBytes: 64,
    });
    router.setOtelHandler((req, res) => service.handleRequest(req, res));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    router.setOtelHandler(null);
    vi.restoreAllMocks();
  });

  const token = async (sessionId = "sess") => {
    const spawn = await service.beginSpawn(sessionId, "cli");
    if (!spawn) throw new Error("no spawn");
    return spawn;
  };
  const auth = (t: string) => ({ "x-cockpit-otel-token": t });

  it("gives a spawn a token only when switched on and storable, starting the store once", async () => {
    enabled = false;
    expect(await service.beginSpawn("s", "c")).toBeNull();
    expect(startStore).not.toHaveBeenCalled();
    enabled = true;
    const a = await token();
    const b = await token();
    expect(a.token).toMatch(/^[0-9a-f]{48}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.spawnId).not.toBe(b.spawnId);
    expect(startStore).toHaveBeenCalledTimes(1);
    store.available = false;
    expect(await service.beginSpawn("s", "c")).toBeNull();
    expect((await service.stats()).spawns).toMatchObject({ off: 2 });
  });

  it("stores what a spawn sends, under the session its token belongs to", async () => {
    const { token: t, spawnId } = await token("sess-a");
    vi.mocked(console.log).mockClear();
    const reply = await post(url, { path: "/otel/v1/traces", headers: auth(t), body: '{"resourceSpans":[]}' });
    expect(reply).toMatchObject({ status: 200, body: "{}" });
    expect(store.received).toHaveLength(1);
    expect(store.received[0].meta).toEqual({ sessionId: "sess-a", spawnId, kind: "traces", receivedMs: now, gzip: false });
    expect(Buffer.from(store.received[0].body).toString()).toBe('{"resourceSpans":[]}');
    const zipped = await post(url, {
      path: "/otel/v1/metrics?x=1",
      headers: { ...auth(t), "content-encoding": "gzip" },
      body: gzipSync("{}"),
    });
    expect(zipped.status).toBe(200);
    expect(store.received[1].meta).toMatchObject({ kind: "metrics", gzip: true });
    // Nothing logged per request: these arrive every few seconds per session.
    expect(console.log).not.toHaveBeenCalled();
  });

  it("refuses an unknown token before reading anything, and closes the connection", async () => {
    const reply = await post(url, { headers: auth("nope") });
    expect(reply.status).toBe(403);
    expect(reply.headers.connection).toBe("close");
    expect((await post(url)).status).toBe(403);
    expect(store.received).toHaveLength(0);
    expect((await service.stats()).dropped.unknownToken).toBe(2);
  });

  it("refuses anything but JSON, a body over the limit, a wrong path and a wrong method", async () => {
    const { token: t } = await token();
    expect((await post(url, { headers: { ...auth(t), "content-type": "application/x-protobuf" } })).status).toBe(415);
    expect((await post(url, { headers: auth(t), body: "x".repeat(65) })).status).toBe(413);
    expect((await post(url, { headers: auth(t), body: "x".repeat(200), chunked: true })).status).toBe(413);
    expect((await post(url, { path: "/otel/v1/profiles", headers: auth(t) })).status).toBe(404);
    expect((await post(url, { method: "PUT", headers: auth(t) })).status).toBe(405);
    expect(store.received).toHaveLength(0);
    expect((await service.stats()).dropped).toMatchObject({ unsupportedType: 1, oversize: 2 });
  });

  it("asks the exporter to retry when the store is full, and drops while switched off or unavailable", async () => {
    const { token: t } = await token();
    store.next = "full";
    const full = await post(url, { headers: auth(t) });
    expect(full.status).toBe(429);
    expect(full.headers["retry-after"]).toBe("2");
    store.next = "unavailable";
    expect((await post(url, { headers: auth(t) })).status).toBe(200);
    enabled = false;
    expect((await post(url, { headers: auth(t) })).status).toBe(200);
    expect(store.received).toHaveLength(2);
    expect((await service.stats()).dropped).toMatchObject({ queueFull: 1, unavailable: 1, disabled: 1 });
  });

  it("keeps a finished spawn's token for its last flush, then retires it, while a respawn has its own", async () => {
    const old = await token("sess");
    const fresh = await token("sess");
    service.endSpawn(old.token);
    now += 59_000;
    expect((await post(url, { headers: auth(old.token) })).status).toBe(200);
    now += 2_000;
    expect((await post(url, { headers: auth(old.token) })).status).toBe(403);
    expect((await post(url, { headers: auth(fresh.token) })).status).toBe(200);
    // Ending twice cannot extend the grace; an unknown token is ignored.
    service.endSpawn(fresh.token, 10);
    service.endSpawn(fresh.token, 60_000);
    service.endSpawn("unknown");
    now += 11;
    expect((await post(url, { headers: auth(fresh.token) })).status).toBe(403);
  });

  it("counts how spawns came out, retiring a skipped one's token at once and saying why once", async () => {
    const applied = await token();
    service.noteOutcome(applied.token, { status: "applied" });
    const skipped = await token("sess-skip");
    service.noteOutcome(skipped.token, { status: "skipped", source: "server-managed settings", key: "OTEL_EXPORTER_OTLP_ENDPOINT" });
    const again = await token("sess-skip-2");
    service.noteOutcome(again.token, { status: "skipped", source: "server-managed settings", key: "OTEL_EXPORTER_OTLP_ENDPOINT" });
    expect((await post(url, { headers: auth(skipped.token) })).status).toBe(403);
    const stats = await service.stats();
    expect(stats.spawns).toEqual({ applied: 1, skipped: 2, off: 0 });
    expect(stats.lastSkip).toEqual({
      sessionId: "sess-skip-2",
      source: "server-managed settings",
      key: "OTEL_EXPORTER_OTLP_ENDPOINT",
      at: now,
    });
    expect(vi.mocked(console.log).mock.calls.filter(([m]) => String(m).includes("leaving sessions' telemetry alone"))).toHaveLength(1);
  });

  it("reads through the store, and without starting it when there is nothing to read", async () => {
    enabled = false;
    expect(await service.query({})).toEqual({ records: [], sources: {}, nextCursor: null });
    const idle = await service.stats();
    expect(startStore).not.toHaveBeenCalled();
    expect(idle).toMatchObject({ available: false, reason: "probe says no", enabled: false, store: null });

    enabled = true;
    expect(await service.query({})).toEqual({ records: [], sources: {}, nextCursor: "next" });
    const stats = await service.stats("sess");
    expect(stats).toMatchObject({
      available: true,
      enabled: true,
      ingest: { batches: 2, records: 5, failed: 1, lastError: "bad json", pendingBytes: 0 },
      store: { records: 5 },
    });
    store.statsError = true;
    expect((await service.stats()).store).toBeNull();
    store.available = false;
    store.reason = "worker exited";
    expect(await service.query({})).toEqual({ records: [], sources: {}, nextCursor: null });
    expect(await service.stats()).toMatchObject({ available: false, reason: "worker exited" });
  });
});

describe("HookRouter and the /otel routes", () => {
  it("answers 404 there when no receiver is set, keeps sockets open long enough, and reports a receiver that throws", async () => {
    const router = new HookRouter();
    const addr = await router.start();
    const url = `http://${addr.host}:${addr.port}`;
    try {
      expect((await post(url)).status).toBe(404);
      const server = (router as unknown as { server: { keepAliveTimeout: number; headersTimeout: number } }).server;
      expect(server.keepAliveTimeout).toBeGreaterThanOrEqual(65_000);
      expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      router.setOtelHandler(async () => {
        throw new Error("receiver bug");
      });
      expect((await post(url)).status).toBe(500);
      expect(error).toHaveBeenCalledWith("[hook-router] otel request failed:", expect.any(Error));
      error.mockRestore();
    } finally {
      await router.stop();
    }
  });
});
