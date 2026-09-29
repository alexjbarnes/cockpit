// Proves the fix for the value-validation gap the coordinator found:
// "one construction path" (buildIssue/applyIssueUpdate) stopped a caller
// choosing *which* fields to set, but did nothing about *values*, so the
// REST route passed a raw parsed request body straight through with no
// checks of its own. These tests call the route handlers directly (not
// through a live server) with the exact REST-shaped payloads the coordinator
// measured, against real issue-storage.ts and a real tmpdir via
// COCKPIT_CONFIG_DIR (mirroring tests/issue-storage.test.ts's isolation
// convention) — proving both that the response is 400, not an unhandled
// throw a real Next.js server would turn into a 500 (calling the handler
// directly means a bug here would make `await PUT(...)` itself reject, not
// silently return something), and that the rejected value was never
// persisted.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildIssue, buildProject, getIssue, saveIssue, saveProject } from "@/server/issue-storage";
import type { Project } from "@/types";

vi.mock("@/server/auth", () => ({
  validateSession: () => true,
}));

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cockpit-issueroutes-"));
  prevConfigDir = process.env.COCKPIT_CONFIG_DIR;
  process.env.COCKPIT_CONFIG_DIR = dir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.COCKPIT_CONFIG_DIR;
  else process.env.COCKPIT_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

function makeProject(prefix: string): Project {
  const p = buildProject({ name: `Project ${prefix}`, prefix });
  saveProject(p);
  return p;
}

function authedReq(url: string, init: { method?: string; body?: unknown } = {}): NextRequest {
  return new NextRequest(url, {
    method: init.method,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    headers: { cookie: "cockpit_session=valid", "content-type": "application/json" },
  });
}

describe("PUT /api/issues/[key]", () => {
  it("returns 400, not 500, for an invalid status, and does not persist it (coordinator's exact repro)", async () => {
    const p = makeProject("CK");
    const issue = buildIssue({ projectId: p.id, title: "Original" }, { kind: "user" });
    saveIssue(issue);

    const { PUT, GET } = await import("@/app/api/issues/[key]/route");
    const res = await PUT(
      authedReq(`http://localhost/api/issues/${issue.key}`, { method: "PUT", body: { status: "Definitely Not A Status" } }),
      {
        params: Promise.resolve({ key: issue.key }),
      },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/status must be one of/i);

    const getRes = await GET(authedReq(`http://localhost/api/issues/${issue.key}`), { params: Promise.resolve({ key: issue.key }) });
    expect((await getRes.json()).issue.status).toBe("Backlog");
  });

  it("returns 400, not 500, for a stringly-typed priority", async () => {
    const p = makeProject("CK");
    const issue = buildIssue({ projectId: p.id, title: "Original" }, { kind: "user" });
    saveIssue(issue);

    const { PUT } = await import("@/app/api/issues/[key]/route");
    const res = await PUT(authedReq(`http://localhost/api/issues/${issue.key}`, { method: "PUT", body: { priority: "critical" } }), {
      params: Promise.resolve({ key: issue.key }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/priority must be one of/i);
  });

  it("returns 400, not 500, for a non-array labels value", async () => {
    const p = makeProject("CK");
    const issue = buildIssue({ projectId: p.id, title: "Original" }, { kind: "user" });
    saveIssue(issue);

    const { PUT } = await import("@/app/api/issues/[key]/route");
    const res = await PUT(authedReq(`http://localhost/api/issues/${issue.key}`, { method: "PUT", body: { labels: "not-an-array" } }), {
      params: Promise.resolve({ key: issue.key }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/labels must be an array of strings/i);
  });

  it("returns 400, not 500, for a numeric title", async () => {
    const p = makeProject("CK");
    const issue = buildIssue({ projectId: p.id, title: "Original" }, { kind: "user" });
    saveIssue(issue);

    const { PUT } = await import("@/app/api/issues/[key]/route");
    const res = await PUT(authedReq(`http://localhost/api/issues/${issue.key}`, { method: "PUT", body: { title: 12345 } }), {
      params: Promise.resolve({ key: issue.key }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/title must be a non-empty string/i);
  });

  it("still applies a valid update and returns 200", async () => {
    const p = makeProject("CK");
    const issue = buildIssue({ projectId: p.id, title: "Original" }, { kind: "user" });
    saveIssue(issue);

    const { PUT } = await import("@/app/api/issues/[key]/route");
    const res = await PUT(authedReq(`http://localhost/api/issues/${issue.key}`, { method: "PUT", body: { status: "Refine Ready" } }), {
      params: Promise.resolve({ key: issue.key }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).issue.status).toBe("Refine Ready");
  });
});

describe("POST /api/issues", () => {
  it("returns 400, not 500, for a numeric title", async () => {
    const p = makeProject("CK");
    const { POST } = await import("@/app/api/issues/route");
    const res = await POST(authedReq("http://localhost/api/issues", { method: "POST", body: { projectId: p.id, title: 12345 } }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/title must be a non-empty string/i);
  });

  it("returns 400, not 500, for a non-array labels value", async () => {
    const p = makeProject("CK");
    const { POST } = await import("@/app/api/issues/route");
    const res = await POST(
      authedReq("http://localhost/api/issues", { method: "POST", body: { projectId: p.id, title: "t", labels: "not-an-array" } }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/labels must be an array of strings/i);
  });

  it("still creates a valid issue and returns 201", async () => {
    const p = makeProject("CK");
    const { POST } = await import("@/app/api/issues/route");
    const res = await POST(authedReq("http://localhost/api/issues", { method: "POST", body: { projectId: p.id, title: "A real issue" } }));

    expect(res.status).toBe(201);
    expect((await res.json()).issue.title).toBe("A real issue");
  });
});

// Deleting an issue is permanent and only reachable from the UI, so the
// route is the whole guard: a key that resolves to nothing must not read as a
// successful deletion, and a delete must not take anything else with it.
describe("DELETE /api/issues/[key]", () => {
  it("removes the issue and leaves its siblings alone", async () => {
    const { DELETE } = await import("@/app/api/issues/[key]/route");
    const project = makeProject("DEL");
    const doomed = buildIssue({ projectId: project.id, title: "goes" }, { kind: "user" });
    const keeper = buildIssue({ projectId: project.id, title: "stays" }, { kind: "user" });
    saveIssue(doomed);
    saveIssue(keeper);

    const res = await DELETE(authedReq(`http://localhost/api/issues/${doomed.key}`, { method: "DELETE" }), {
      params: Promise.resolve({ key: doomed.key }),
    });

    expect(res.status).toBe(200);
    expect(getIssue(doomed.key)).toBeUndefined();
    expect(getIssue(keeper.key)?.title).toBe("stays");
  });

  it("answers 404 for a key that resolves to nothing, rather than a cheerful ok", async () => {
    const { DELETE } = await import("@/app/api/issues/[key]/route");
    makeProject("NOPE");
    for (const key of ["NOPE-99", "MISSING-1", "not-a-key", ""]) {
      const res = await DELETE(authedReq(`http://localhost/api/issues/${key}`, { method: "DELETE" }), {
        params: Promise.resolve({ key }),
      });
      expect(res.status, `key "${key}"`).toBe(404);
    }
  });

  it("refuses an unauthenticated delete", async () => {
    const { DELETE } = await import("@/app/api/issues/[key]/route");
    const project = makeProject("AUTH");
    const issue = buildIssue({ projectId: project.id, title: "keep me" }, { kind: "user" });
    saveIssue(issue);

    const unauthed = new NextRequest(`http://localhost/api/issues/${issue.key}`, { method: "DELETE" });
    const res = await DELETE(unauthed, { params: Promise.resolve({ key: issue.key }) });

    expect(res.status).toBe(401);
    expect(getIssue(issue.key), "the issue must survive a rejected request").toBeDefined();
  });

  it("matches the key case-insensitively, the way getIssue does", async () => {
    const { DELETE } = await import("@/app/api/issues/[key]/route");
    const project = makeProject("CASE");
    const issue = buildIssue({ projectId: project.id, title: "lower" }, { kind: "user" });
    saveIssue(issue);

    const res = await DELETE(authedReq(`http://localhost/api/issues/${issue.key.toLowerCase()}`, { method: "DELETE" }), {
      params: Promise.resolve({ key: issue.key.toLowerCase() }),
    });

    expect(res.status).toBe(200);
    expect(getIssue(issue.key)).toBeUndefined();
  });

  it("does not rewind the key counter, so a deleted key is never reused", async () => {
    const { DELETE } = await import("@/app/api/issues/[key]/route");
    // The key is how an issue is named in branches, PR titles, worktree paths
    // and other issues' comments. Handing it to a different issue later would
    // silently repoint all of them.
    const project = makeProject("KEEP");
    const first = buildIssue({ projectId: project.id, title: "first" }, { kind: "user" });
    saveIssue(first);

    await DELETE(authedReq(`http://localhost/api/issues/${first.key}`, { method: "DELETE" }), {
      params: Promise.resolve({ key: first.key }),
    });

    const next = buildIssue({ projectId: project.id, title: "second" }, { kind: "user" });
    expect(next.key).not.toBe(first.key);
  });
});
