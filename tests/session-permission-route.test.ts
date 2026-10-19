// POST /api/sessions/[id]/permissions/[requestId] — the route a push
// notification's Approve and Deny buttons call, with no app open.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pending: undefined as { type: "permission" | "question"; requestId: string } | undefined,
  respond: vi.fn(() => true),
}));

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));
vi.mock("@/server/singleton", () => ({
  getSessionManager: () => ({
    getPendingRequest: () => h.pending,
    respondToPermission: h.respond,
  }),
}));

import { POST } from "@/app/api/sessions/[id]/permissions/[requestId]/route";

function answer(body: unknown, token = "valid") {
  return POST(
    new NextRequest("http://localhost/api/sessions/sess-1/permissions/req-1", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `cockpit_session=${token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "sess-1", requestId: "req-1" }) },
  );
}

beforeEach(() => {
  h.respond.mockClear();
  h.respond.mockReturnValue(true);
  h.pending = { type: "permission", requestId: "req-1" };
});

describe("answering from a notification", () => {
  it("approves the request", async () => {
    const res = await answer({ allowed: true });

    expect(res.status).toBe(200);
    expect(h.respond).toHaveBeenCalledWith("sess-1", "req-1", true);
  });

  it("denies it", async () => {
    await answer({ allowed: false });
    expect(h.respond).toHaveBeenCalledWith("sess-1", "req-1", false);
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await answer({ allowed: true }, "nope");
    expect(res.status).toBe(401);
    expect(h.respond).not.toHaveBeenCalled();
  });

  it("refuses anything that is not a boolean, so a string cannot approve by accident", async () => {
    for (const allowed of ["false", 0, null, undefined]) {
      const res = await answer({ allowed });
      expect(res.status, `allowed=${JSON.stringify(allowed)}`).toBe(400);
    }
    expect(h.respond).not.toHaveBeenCalled();
  });

  it("404s for a request that is no longer waiting", async () => {
    h.pending = undefined;
    const res = await answer({ allowed: true });

    expect(res.status).toBe(404);
    expect(h.respond).not.toHaveBeenCalled();
  });

  it("refuses a question, which needs answers rather than a yes", async () => {
    h.pending = { type: "question", requestId: "req-1" };
    const res = await answer({ allowed: true });

    expect(res.status).toBe(400);
    expect(h.respond).not.toHaveBeenCalled();
  });

  it("409s when the session is no longer running", async () => {
    h.respond.mockReturnValue(false);
    const res = await answer({ allowed: true });

    expect(res.status).toBe(409);
  });
});
