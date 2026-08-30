// POST /api/trust — the button on the "Directory not trusted" card. Unfenced by
// design: it only runs because a person clicked it on the session that could
// not start, so the trust decision is theirs, unlike the job-scratchpad path
// that decides for itself.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));

const { trust } = vi.hoisted(() => ({
  trust: { granted: [] as string[], trusted: new Set<string>(), fail: false },
}));
vi.mock("@/server/workspace-trust", () => ({
  trustDirectory: (dir: string) => {
    if (trust.fail) return false;
    trust.granted.push(dir);
    const isNew = !trust.trusted.has(dir);
    trust.trusted.add(dir);
    return isNew;
  },
  isDirectoryTrusted: (dir: string) => trust.trusted.has(dir),
}));

function makeReq(body: unknown, token = "valid"): NextRequest {
  return new NextRequest("http://localhost/api/trust", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { cookie: `cockpit_session=${token}`, "content-type": "application/json" },
  });
}

describe("POST /api/trust", () => {
  beforeEach(() => {
    vi.resetModules();
    trust.granted = [];
    trust.trusted = new Set();
    trust.fail = false;
  });

  it("rejects an unauthenticated request without touching the config", async () => {
    const { POST } = await import("@/app/api/trust/route");
    const res = await POST(makeReq({ cwd: "/home/dev/repos/x" }, "nope"));

    expect(res.status).toBe(401);
    expect(trust.granted).toEqual([]);
  });

  it("grants trust for the directory", async () => {
    const { POST } = await import("@/app/api/trust/route");
    const res = await POST(makeReq({ cwd: "/home/dev/repos/x" }));

    expect(await res.json()).toEqual({ trusted: true, added: true });
    expect(trust.granted).toEqual(["/home/dev/repos/x"]);
  });

  // A double click, or a grant that raced the CLI writing its own entry, must
  // still let the client move on and retry the session.
  it("reports success for an already-trusted directory", async () => {
    trust.trusted.add("/home/dev/repos/x");
    const { POST } = await import("@/app/api/trust/route");
    const res = await POST(makeReq({ cwd: "/home/dev/repos/x" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ trusted: true, added: false });
  });

  it("400s on a missing or blank cwd", async () => {
    const { POST } = await import("@/app/api/trust/route");
    expect((await POST(makeReq({}))).status).toBe(400);
    expect((await POST(makeReq({ cwd: "   " }))).status).toBe(400);
    expect(trust.granted).toEqual([]);
  });

  it("500s when the config could not be written, so the card can say so", async () => {
    trust.fail = true;
    const { POST } = await import("@/app/api/trust/route");
    const res = await POST(makeReq({ cwd: "/home/dev/repos/x" }));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/could not record trust/i);
  });
});
