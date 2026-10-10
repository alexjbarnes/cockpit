// What a failed connect tells the user.
//
// A connect route answers 401 for one thing only: the provider refused the key.
// Everything else — host unreachable, timeout, 5xx, an empty list — is a
// transport or catalog problem, and answering 401 sends the user off to
// re-paste a key that was never wrong. That is not hypothetical: OpenCode Go's
// /models is public and answers 200 whatever the Authorization header says
// (empty, junk and 4KB values all measured), so a 401 from its connect route
// could only ever have meant the request never arrived — which is exactly the
// confusion it caused.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sync: {} as Record<string, unknown> }));

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));

vi.mock("@/server/providers", () => ({
  getProvider: () => ({ id: "zen-go", models: [] }),
  syncZenModels: async () => h.sync,
  syncGoModels: async () => h.sync,
  syncDeepSeekModels: async () => h.sync,
  syncCommandCodeModels: async () => h.sync,
}));

import { POST as connectCommandCode } from "@/app/api/providers/commandcode/connect/route";
import { POST as connectDeepSeek } from "@/app/api/providers/deepseek/connect/route";
import { POST as connectZen } from "@/app/api/providers/zen/connect/route";
import { POST as connectZenGo } from "@/app/api/providers/zen-go/connect/route";

function connect(handler: (req: NextRequest) => Promise<Response>): Promise<Response> {
  const req = new NextRequest("http://localhost/api/providers/zen-go/connect", {
    method: "POST",
    headers: { cookie: "cockpit_session=valid", "Content-Type": "application/json" },
    body: JSON.stringify({ key: "zk-1" }),
  });
  return handler(req);
}

describe("connect routes report a transport failure as one", () => {
  beforeEach(() => {
    h.sync = { ok: true, modelCount: 3 };
  });

  it("answers 502, not 401, when the catalog could not be fetched", async () => {
    h.sync = { ok: false, error: "Could not reach OpenCode Go (HTTP 503)" };

    const res = await connect(connectZenGo);

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("Could not reach");
  });

  it("answers 502 when the model list came back empty", async () => {
    h.sync = { ok: false, error: "OpenCode Go returned an empty model list" };
    expect((await connect(connectZenGo)).status).toBe(502);
  });

  // Only a provider that really checks its key can reject one. DeepSeek's
  // authenticated /v1/models 401s a bad key; OpenCode's two lists do not.
  it("answers 401 only when the provider refused the key", async () => {
    h.sync = { ok: false, error: "DeepSeek rejected the API key", rejected: true };

    const res = await connect(connectDeepSeek);

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("DeepSeek rejected the API key");
  });

  it("never answers 401 for OpenCode Zen or Go, whose key is not checked at connect", async () => {
    h.sync = { ok: false, error: "Could not reach OpenCode Zen (HTTP 500)" };
    expect((await connect(connectZen)).status).toBe(502);
    expect((await connect(connectZenGo)).status).toBe(502);
  });

  // CommandCode's catalog is public too, so its key is not checked at connect
  // either — the first turn is where a wrong one surfaces.
  it("answers 502 for CommandCode when its catalog could not be fetched", async () => {
    h.sync = { ok: false, error: "Could not reach CommandCode (HTTP 503)" };
    expect((await connect(connectCommandCode)).status).toBe(502);
  });

  it("passes a successful sync straight through", async () => {
    const res = await connect(connectZenGo);
    expect(res.status).toBe(200);
    expect((await res.json()).sync).toEqual({ ok: true, modelCount: 3 });
  });

  it("still refuses an unauthenticated or empty-key request before any sync", async () => {
    const anon = new NextRequest("http://localhost/api/providers/zen-go/connect", { method: "POST" });
    expect((await connectZenGo(anon)).status).toBe(401);

    const blank = new NextRequest("http://localhost/api/providers/zen-go/connect", {
      method: "POST",
      headers: { cookie: "cockpit_session=valid", "Content-Type": "application/json" },
      body: JSON.stringify({ key: "   " }),
    });
    expect((await connectZenGo(blank)).status).toBe(400);
  });
});
