import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  stored: undefined as string | undefined,
  known: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));

vi.mock("@/server/assistant-settings", () => ({
  getAssistantSettings: () => ({ model: "sonnet", thinkingLevel: "high", sessionId: h.stored }),
}));

vi.mock("@/server/singleton", () => ({
  getSessionManager: () => ({ listKnownSessions: () => h.known }),
}));

import { GET } from "@/app/api/assistant-status/route";

function authedReq(): NextRequest {
  return new NextRequest("http://localhost/api/assistant-status", {
    headers: { cookie: "cockpit_session=valid" },
  });
}

describe("GET /api/assistant-status", () => {
  beforeEach(() => {
    h.stored = undefined;
    h.known = [];
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await GET(new NextRequest("http://localhost/api/assistant-status"));
    expect(res.status).toBe(401);
  });

  it("reports no session when the assistant has never been opened", async () => {
    const body = await (await GET(authedReq())).json();
    expect(body).toEqual({ sessionId: null, status: "idle", pendingRequestCount: 0 });
  });

  it("overlays the live status and pending count of the stored session", async () => {
    h.stored = "sess-1";
    h.known = [{ id: "sess-1", status: "running", pendingRequestCount: 2 }];

    const body = await (await GET(authedReq())).json();
    expect(body).toEqual({ sessionId: "sess-1", status: "running", pendingRequestCount: 2 });
  });

  it("falls back to idle when the stored session is not in memory (restart)", async () => {
    h.stored = "sess-1";
    h.known = [{ id: "other", status: "running", pendingRequestCount: 2 }];

    const body = await (await GET(authedReq())).json();
    expect(body).toEqual({ sessionId: "sess-1", status: "idle", pendingRequestCount: 0 });
  });
});
