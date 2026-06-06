import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ applyCockpitAgentSettings: vi.fn() }));

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));

vi.mock("@/server/assistant-settings", () => ({
  getAssistantSettings: vi.fn(() => ({ model: "sonnet", thinkingLevel: "high" })),
  updateAssistantSettings: vi.fn((p) => ({ model: "sonnet", thinkingLevel: "high", ...p })),
}));

vi.mock("@/server/singleton", () => ({
  getSessionManager: () => ({ applyCockpitAgentSettings: h.applyCockpitAgentSettings }),
}));

import { PATCH } from "@/app/api/assistant-settings/route";
import { updateAssistantSettings } from "@/server/assistant-settings";

const mockUpdate = vi.mocked(updateAssistantSettings);

function makeReq(body: unknown, authed = true): NextRequest {
  return new NextRequest("http://localhost/api/assistant-settings", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: authed ? { cookie: "cockpit_session=valid", "content-type": "application/json" } : { "content-type": "application/json" },
  });
}

describe("PATCH /api/assistant-settings write-through", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.applyCockpitAgentSettings.mockResolvedValue(undefined);
  });

  it("writes the change through to the cockpit session", async () => {
    const res = await PATCH(makeReq({ model: "opus" }));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({ model: "opus" });
    expect(h.applyCockpitAgentSettings).toHaveBeenCalledWith(expect.objectContaining({ model: "opus" }));
  });

  it("does not apply an empty-string model through the write-through", async () => {
    await PATCH(makeReq({ model: "" }));
    expect(h.applyCockpitAgentSettings).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
  });

  it("strips a client-supplied sessionId so it cannot overwrite the stored pointer", async () => {
    await PATCH(makeReq({ model: "opus", sessionId: "attacker-session" }));
    expect(mockUpdate).toHaveBeenCalledWith({ model: "opus" });
    expect(mockUpdate.mock.calls[0][0]).not.toHaveProperty("sessionId");
  });

  it("returns 401 and skips the write-through when unauthenticated", async () => {
    const res = await PATCH(makeReq({ model: "opus" }, false));
    expect(res.status).toBe(401);
    expect(h.applyCockpitAgentSettings).not.toHaveBeenCalled();
  });
});
