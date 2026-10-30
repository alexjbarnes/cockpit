import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(() => ({ id: "session-1" }) as { id: string }),
}));

vi.mock("@/server/auth", () => ({ validateSession: () => true }));
vi.mock("@/server/singleton", () => ({ getSessionManager: () => ({ createSession: mocks.createSession }) }));

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/sessions", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { cookie: "cockpit_session=valid", "content-type": "application/json" },
  });
}

async function post(body: unknown) {
  const { POST } = await import("@/app/api/sessions/route");
  return POST(makeReq(body));
}

describe("POST /api/sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards every creation setting to createSession", async () => {
    const res = await post({
      cwd: "/repo",
      name: "Work",
      runtime: "stream",
      model: " zen:kimi-k3 ",
      contextSize: "1m",
      thinkingLevel: "medium",
      permissionMode: "bypass",
      sandbox: { enabled: true, allowedDomains: ["github.com"] },
      notifications: { providerId: "telegram", events: { finished: false, question: "yes" } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: "session-1" });
    expect(mocks.createSession).toHaveBeenCalledWith("/repo", "Work", {
      runtime: "stream",
      permissionMode: "bypass",
      sandbox: { enabled: true, allowedDomains: ["github.com"] },
      model: "zen:kimi-k3",
      contextSize: "1m",
      thinkingLevel: "medium",
      notifications: { providerId: "telegram", events: { finished: false } },
      bypassPermissions: undefined,
      cockpitAgent: undefined,
    });
  });

  it("keeps the legacy bypass flag and an unknown runtime lenient", async () => {
    const res = await post({ cwd: "/repo", bypassPermissions: true, runtime: "wat" });
    expect(res.status).toBe(200);
    expect(mocks.createSession).toHaveBeenCalledWith(
      "/repo",
      undefined,
      expect.objectContaining({ runtime: undefined, bypassPermissions: true }),
    );
  });

  it("omits a null notifications choice rather than sending it", async () => {
    const res = await post({ cwd: "/repo", notifications: null });
    expect(res.status).toBe(200);
    expect(mocks.createSession).toHaveBeenCalledWith("/repo", undefined, expect.objectContaining({ notifications: undefined }));
  });

  it("requires a working directory", async () => {
    const res = await post({ name: "Work" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "cwd is required" });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it.each([
    [{ contextSize: "400k" }, "contextSize must be 200k or 1m"],
    [{ thinkingLevel: "extreme" }, "invalid thinkingLevel"],
    [{ permissionMode: "sometimes" }, "invalid permissionMode"],
    [{ sandbox: { enabled: "yes" } }, "invalid sandbox"],
    [{ notifications: { events: { finished: true } } }, "invalid notifications"],
  ])("rejects invalid settings: %o", async (extra, message) => {
    const res = await post({ cwd: "/repo", ...extra });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: message });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
