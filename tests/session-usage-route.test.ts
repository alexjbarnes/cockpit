// GET /api/sessions/[id]/usage — cumulative token spend for the session-usage
// panel. Summed across the CLI-session chain, because a /clear starts a new CLI
// session id and the panel reports what the whole session cost, not the latest
// leg of it.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));

const { prefs } = vi.hoisted(() => ({
  prefs: { current: null as null | { cliSessionId?: string; previousCliSessionIds?: string[] } },
}));
vi.mock("@/server/session-prefs", () => ({ getSessionPrefs: () => prefs.current }));

const { sums } = vi.hoisted(() => ({
  sums: { byId: {} as Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> },
}));
vi.mock("@/server/transcript", () => ({
  findSessionCwd: vi.fn().mockResolvedValue(null),
  sumTranscriptUsage: (sessionId: string) => Promise.resolve(sums.byId[sessionId] ?? { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }),
}));

function makeReq(query = "?cwd=%2Ftmp%2Fwork", token = "valid"): NextRequest {
  return new NextRequest(`http://localhost/api/sessions/s1/usage${query}`, {
    headers: { cookie: `cockpit_session=${token}` },
  });
}

const params = Promise.resolve({ id: "s1" });

describe("GET /api/sessions/[id]/usage", () => {
  beforeEach(() => {
    vi.resetModules();
    prefs.current = null;
    sums.byId = {};
  });

  it("rejects an unauthenticated request", async () => {
    const { GET } = await import("@/app/api/sessions/[id]/usage/route");
    const res = await GET(makeReq("?cwd=%2Ftmp", "nope"), { params });
    expect(res.status).toBe(401);
  });

  it("returns the session's totals", async () => {
    sums.byId.s1 = { input: 120, output: 40, cacheRead: 880, cacheCreate: 200 };
    const { GET } = await import("@/app/api/sessions/[id]/usage/route");
    const res = await GET(makeReq(), { params });

    expect(await res.json()).toEqual({ input: 120, output: 40, cacheRead: 880, cacheCreate: 200 });
  });

  it("sums every CLI session in the chain, so a /clear does not lose the earlier spend", async () => {
    prefs.current = { cliSessionId: "cli-2", previousCliSessionIds: ["cli-1"] };
    sums.byId["cli-1"] = { input: 100, output: 10, cacheRead: 5, cacheCreate: 1 };
    sums.byId["cli-2"] = { input: 20, output: 2, cacheRead: 3, cacheCreate: 4 };

    const { GET } = await import("@/app/api/sessions/[id]/usage/route");
    const res = await GET(makeReq(), { params });

    expect(await res.json()).toEqual({ input: 120, output: 12, cacheRead: 8, cacheCreate: 5 });
  });

  it("400s when no cwd is given and none can be found", async () => {
    const { GET } = await import("@/app/api/sessions/[id]/usage/route");
    const res = await GET(makeReq(""), { params });
    expect(res.status).toBe(400);
  });
});
