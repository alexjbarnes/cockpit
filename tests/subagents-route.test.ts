import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/sessions/[id]/subagents/route";

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));

const h = vi.hoisted(() => ({
  prefs: undefined as unknown,
  cwd: null as string | null,
  metas: [] as { toolUseId: string; agentType: string; description: string }[],
  messages: null as unknown,
}));

vi.mock("@/server/session-prefs", () => ({
  getSessionPrefs: vi.fn(() => h.prefs),
}));

vi.mock("@/server/transcript", () => ({
  findSessionCwd: vi.fn(() => Promise.resolve(h.cwd)),
}));

vi.mock("@/server/subagent-transcript", () => ({
  listSubagentMetasForSessions: vi.fn(() => Promise.resolve(h.metas)),
  loadSubagentByToolUse: vi.fn(() => Promise.resolve(h.messages)),
}));

function req(url: string, opts?: { auth?: boolean }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts?.auth !== false) headers.authorization = "Bearer valid";
  return new NextRequest(url, { headers });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/sessions/[id]/subagents", () => {
  beforeEach(() => {
    h.prefs = { cliSessionId: "cli-1", previousCliSessionIds: [] };
    h.cwd = null;
    h.metas = [];
    h.messages = null;
  });

  it("401 without a valid token", async () => {
    const res = await GET(req("http://x/api/sessions/s1/subagents?cwd=/repo", { auth: false }), params("s1"));
    expect(res.status).toBe(401);
  });

  it("400 when cwd cannot be resolved", async () => {
    h.cwd = null;
    const res = await GET(req("http://x/api/sessions/s1/subagents"), params("s1"));
    expect(res.status).toBe(400);
  });

  it("lists subagents when no toolUseId is given", async () => {
    h.metas = [{ toolUseId: "toolu_1", agentType: "Explore", description: "d" }];
    const res = await GET(req("http://x/api/sessions/s1/subagents?cwd=/repo"), params("s1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subagents).toEqual([{ toolUseId: "toolu_1", agentType: "Explore", description: "d" }]);
  });

  it("returns messages for a matched toolUseId", async () => {
    h.messages = [{ id: "m1", role: "assistant", content: "hi", toolUses: [], blocks: [], timestamp: 1 }];
    const res = await GET(req("http://x/api/sessions/s1/subagents?cwd=/repo&toolUseId=toolu_1"), params("s1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(1);
  });

  it("404 when no subagent maps to the toolUseId", async () => {
    h.messages = null;
    const res = await GET(req("http://x/api/sessions/s1/subagents?cwd=/repo&toolUseId=nope"), params("s1"));
    expect(res.status).toBe(404);
  });

  it("resolves cwd via findSessionCwd when not passed", async () => {
    h.cwd = "/resolved/repo";
    h.metas = [];
    const res = await GET(req("http://x/api/sessions/s1/subagents"), params("s1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subagents).toEqual([]);
  });
});
