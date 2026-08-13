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
import { buildIssue, buildProject, saveIssue, saveProject } from "@/server/issue-storage";
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
