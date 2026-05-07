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
  return new NextRequest("http://localhost/api/reviews/pinned", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { cookie: "cockpit_session=valid", "content-type": "application/json" },
  });
}

describe("PATCH /api/reviews/pinned", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("appends new id to end of list", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue('["a","b"]');
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);

    const { PATCH } = await import("@/app/api/reviews/pinned/route");
    const res = await PATCH(makeReq({ add: "c" }));
    const body = await res.json();

    expect(body.pinned).toEqual(["a", "b", "c"]);
  });

  it("does not duplicate existing id", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue('["a","b"]');
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);

    const { PATCH } = await import("@/app/api/reviews/pinned/route");
    const res = await PATCH(makeReq({ add: "a" }));
    const body = await res.json();

    expect(body.pinned).toEqual(["a", "b"]);
  });

  it("removes id while preserving order", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue('["a","b","c"]');
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);

    const { PATCH } = await import("@/app/api/reviews/pinned/route");
    const res = await PATCH(makeReq({ remove: "b" }));
    const body = await res.json();

    expect(body.pinned).toEqual(["a", "c"]);
  });

  it("handles empty file gracefully", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);

    const { PATCH } = await import("@/app/api/reviews/pinned/route");
    const res = await PATCH(makeReq({ add: "first" }));
    const body = await res.json();

    expect(body.pinned).toEqual(["first"]);
  });

  it("rejects non-string add value", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue('["a"]');
    const { PATCH } = await import("@/app/api/reviews/pinned/route");
    const res = await PATCH(makeReq({ add: 42 }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/reviews/pinned", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns pinned review list", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue('["rev-1","rev-2"]');
    const { GET } = await import("@/app/api/reviews/pinned/route");
    const req = new NextRequest("http://localhost/api/reviews/pinned", {
      headers: { cookie: "cockpit_session=valid" },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.pinned).toEqual(["rev-1", "rev-2"]);
  });

  it("returns empty array when file does not exist", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
    const { GET } = await import("@/app/api/reviews/pinned/route");
    const req = new NextRequest("http://localhost/api/reviews/pinned", {
      headers: { cookie: "cockpit_session=valid" },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.pinned).toEqual([]);
  });
});

describe("PUT /api/reviews/pinned", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("replaces the full pinned list", async () => {
    const fs = await import("node:fs/promises");
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);
    const { PUT } = await import("@/app/api/reviews/pinned/route");
    const req = new NextRequest("http://localhost/api/reviews/pinned", {
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
    const { PUT } = await import("@/app/api/reviews/pinned/route");
    const req = new NextRequest("http://localhost/api/reviews/pinned", {
      method: "PUT",
      body: JSON.stringify({ pinned: "not-array" }),
      headers: { cookie: "cockpit_session=valid", "content-type": "application/json" },
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });
});
