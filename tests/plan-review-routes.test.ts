// The session plan routes, called directly against the real store in a
// throwaway config dir.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPlanRecord, recordPlanVersion } from "@/server/plan-review-storage";

const auth = vi.hoisted(() => ({ ok: true }));
vi.mock("@/server/auth", () => ({ validateSession: () => auth.ok }));

const pendingRequests = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));
vi.mock("@/server/singleton", () => ({
  getSessionManager: () => ({ getPendingRequests: () => pendingRequests.list }),
}));

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cockpit-planroutes-"));
  prev = process.env.COCKPIT_CONFIG_DIR;
  process.env.COCKPIT_CONFIG_DIR = dir;
  auth.ok = true;
  pendingRequests.list = [];
});

afterEach(() => {
  if (prev === undefined) delete process.env.COCKPIT_CONFIG_DIR;
  else process.env.COCKPIT_CONFIG_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

function req(url: string, init: { method?: string; body?: unknown; raw?: string } = {}): NextRequest {
  return new NextRequest(url, {
    method: init.method,
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const subject = { kind: "session" as const, id: "s1" };
const note = { id: "n1", kind: "note", quote: "", prefix: "", suffix: "", body: "Shorter please", createdAt: 1 };

describe("GET /api/sessions/[id]/plan-review", () => {
  it("returns versions, the draft and the version waiting for an answer", async () => {
    const { GET } = await import("@/app/api/sessions/[id]/plan-review/route");
    recordPlanVersion(subject, { content: "# One", requestId: "r1" });
    pendingRequests.list = [
      { toolName: "Bash", requestId: "other" },
      { toolName: "ExitPlanMode", requestId: "r1", planVersion: 1 },
    ];
    const res = await GET(req("http://x/api/sessions/s1/plan-review"), params("s1"));
    const body = await res.json();
    expect(body.versions).toHaveLength(1);
    expect(body.draft).toBeNull();
    expect(body.pending).toEqual({ requestId: "r1", version: 1 });
  });

  it("reports nothing pending, and no version when the request has none", async () => {
    const { GET } = await import("@/app/api/sessions/[id]/plan-review/route");
    expect((await (await GET(req("http://x/"), params("s1"))).json()).pending).toBeNull();
    pendingRequests.list = [{ toolName: "ExitPlanMode", requestId: "r9" }];
    expect((await (await GET(req("http://x/"), params("s1"))).json()).pending).toEqual({ requestId: "r9", version: null });
  });

  it("refuses an unauthenticated caller", async () => {
    const { GET } = await import("@/app/api/sessions/[id]/plan-review/route");
    auth.ok = false;
    expect((await GET(req("http://x/"), params("s1"))).status).toBe(401);
  });
});

describe("PUT /api/sessions/[id]/plan-review/draft", () => {
  it("saves a draft and clears it", async () => {
    const { PUT } = await import("@/app/api/sessions/[id]/plan-review/draft/route");
    recordPlanVersion(subject, { content: "# One" });
    const saved = await PUT(
      req("http://x/", { method: "PUT", body: { draft: { version: 1, annotations: [note], updatedAt: 5 } } }),
      params("s1"),
    );
    expect((await saved.json()).draft).toMatchObject({ version: 1, updatedAt: 5 });
    expect(readPlanRecord(subject).draft?.annotations).toHaveLength(1);

    const cleared = await PUT(req("http://x/", { method: "PUT", body: { draft: null } }), params("s1"));
    expect(await cleared.json()).toEqual({ draft: null });
    expect(readPlanRecord(subject).draft).toBeUndefined();
  });

  it("fills in what a draft leaves out", async () => {
    const { PUT } = await import("@/app/api/sessions/[id]/plan-review/draft/route");
    recordPlanVersion(subject, { content: "# One" });
    const res = await PUT(req("http://x/", { method: "PUT", body: { draft: { version: 1, editedText: "# One, edited" } } }), params("s1"));
    const { draft } = await res.json();
    expect(draft).toMatchObject({ editedText: "# One, edited", annotations: [] });
    expect(typeof draft.updatedAt).toBe("number");
  });

  it("answers null for a draft on a version that does not exist", async () => {
    const { PUT } = await import("@/app/api/sessions/[id]/plan-review/draft/route");
    const res = await PUT(req("http://x/", { method: "PUT", body: { draft: { version: 3, annotations: [note] } } }), params("s1"));
    expect(await res.json()).toEqual({ draft: null });
  });

  it("rejects a body that is not a draft", async () => {
    const { PUT } = await import("@/app/api/sessions/[id]/plan-review/draft/route");
    expect((await PUT(req("http://x/", { method: "PUT", raw: "{not json" }), params("s1"))).status).toBe(400);
    expect((await PUT(req("http://x/", { method: "PUT", body: {} }), params("s1"))).status).toBe(400);
    expect((await PUT(req("http://x/", { method: "PUT", body: { draft: { version: "1" } } }), params("s1"))).status).toBe(400);
    // An id that could not be a file name fails cleanly, not with a thrown 500.
    recordPlanVersion(subject, { content: "# One" });
    expect(
      (await PUT(req("http://x/", { method: "PUT", body: { draft: { version: 1, annotations: [note] } } }), params("../bad"))).status,
    ).toBe(200);
  });

  it("refuses an unauthenticated caller", async () => {
    const { PUT } = await import("@/app/api/sessions/[id]/plan-review/draft/route");
    auth.ok = false;
    expect((await PUT(req("http://x/", { method: "PUT", body: { draft: null } }), params("s1"))).status).toBe(401);
  });
});
