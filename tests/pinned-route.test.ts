import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock("@/server/auth", () => ({
  validateSession: () => true,
}));

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/sessions/pinned", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { cookie: "cockpit_session=valid", "content-type": "application/json" },
  });
}

describe("PATCH /api/sessions/pinned", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("appends new id to end of list", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue('["a","b","c"]');
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);

    const { PATCH } = await import("@/app/api/sessions/pinned/route");
    const res = await PATCH(makeReq({ add: "d" }));
    const body = await res.json();

    expect(body.pinned).toEqual(["a", "b", "c", "d"]);
  });

  it("does not duplicate existing id on add", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue('["a","b","c"]');
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);

    const { PATCH } = await import("@/app/api/sessions/pinned/route");
    const res = await PATCH(makeReq({ add: "b" }));
    const body = await res.json();

    expect(body.pinned).toEqual(["a", "b", "c"]);
  });

  it("removes id while preserving order of others", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue('["a","b","c","d"]');
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);

    const { PATCH } = await import("@/app/api/sessions/pinned/route");
    const res = await PATCH(makeReq({ remove: "b" }));
    const body = await res.json();

    expect(body.pinned).toEqual(["a", "c", "d"]);
  });

  it("removing absent id is a no-op", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue('["a","b","c"]');
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);

    const { PATCH } = await import("@/app/api/sessions/pinned/route");
    const res = await PATCH(makeReq({ remove: "z" }));
    const body = await res.json();

    expect(body.pinned).toEqual(["a", "b", "c"]);
  });

  it("reads from empty file returns empty array", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);

    const { PATCH } = await import("@/app/api/sessions/pinned/route");
    const res = await PATCH(makeReq({ add: "first" }));
    const body = await res.json();

    expect(body.pinned).toEqual(["first"]);
  });

  it("preserves order across multiple adds", async () => {
    const fs = await import("node:fs/promises");
    let stored = "[]";
    vi.mocked(fs.readFile).mockImplementation(async () => stored);
    vi.mocked(fs.writeFile).mockImplementation(async (_p, content) => {
      stored = String(content).trim();
    });
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);

    const { PATCH } = await import("@/app/api/sessions/pinned/route");
    await PATCH(makeReq({ add: "first" }));
    await PATCH(makeReq({ add: "second" }));
    const res = await PATCH(makeReq({ add: "third" }));
    const body = await res.json();

    expect(body.pinned).toEqual(["first", "second", "third"]);
  });

  it("rejects non-string add value", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue('["a"]');
    const { PATCH } = await import("@/app/api/sessions/pinned/route");
    const res = await PATCH(makeReq({ add: 42 }));
    expect(res.status).toBe(400);
  });

  it("rejects non-string remove value", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue('["a"]');
    const { PATCH } = await import("@/app/api/sessions/pinned/route");
    const res = await PATCH(makeReq({ remove: 123 }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/sessions/pinned", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns pinned session list", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue('["sess-1","sess-2"]');
    const { GET } = await import("@/app/api/sessions/pinned/route");
    const req = new NextRequest("http://localhost/api/sessions/pinned", {
      headers: { cookie: "cockpit_session=valid" },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.pinned).toEqual(["sess-1", "sess-2"]);
  });

  it("returns empty array when file does not exist", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
    const { GET } = await import("@/app/api/sessions/pinned/route");
    const req = new NextRequest("http://localhost/api/sessions/pinned", {
      headers: { cookie: "cockpit_session=valid" },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.pinned).toEqual([]);
  });
});

describe("PUT /api/sessions/pinned", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("replaces the full pinned list", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);
    const { PUT } = await import("@/app/api/sessions/pinned/route");
    const req = new NextRequest("http://localhost/api/sessions/pinned", {
      method: "PUT",
      body: JSON.stringify({ pinned: ["x", "y"] }),
      headers: { cookie: "cockpit_session=valid", "content-type": "application/json" },
    });
    const res = await PUT(req);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(vi.mocked(fs.writeFile)).toHaveBeenCalled();
  });

  it("rejects invalid pinned format", async () => {
    const { PUT } = await import("@/app/api/sessions/pinned/route");
    const req = new NextRequest("http://localhost/api/sessions/pinned", {
      method: "PUT",
      body: JSON.stringify({ pinned: "not-array" }),
      headers: { cookie: "cockpit_session=valid", "content-type": "application/json" },
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("rejects pinned array with non-string elements", async () => {
    const { PUT } = await import("@/app/api/sessions/pinned/route");
    const req = new NextRequest("http://localhost/api/sessions/pinned", {
      method: "PUT",
      body: JSON.stringify({ pinned: ["a", 123] }),
      headers: { cookie: "cockpit_session=valid", "content-type": "application/json" },
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });
});
