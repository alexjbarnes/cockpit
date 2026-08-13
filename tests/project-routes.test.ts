// Proves the fix for the same value-validation gap as tests/issue-routes.test.ts,
// on the project side: buildProject/applyProjectUpdate now validate
// name/prefix/description/repoPath/archived, and the routes were fixed to
// call them *inside* their try block so a thrown validation error becomes a
// 400 instead of an unhandled 500. The coordinator's specific example: a
// non-string prefix used to 500 because normalizePrefix called `.trim()` on
// it directly.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProject, saveProject } from "@/server/issue-storage";
import type { Project } from "@/types";

vi.mock("@/server/auth", () => ({
  validateSession: () => true,
}));

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cockpit-projectroutes-"));
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

describe("POST /api/projects", () => {
  it("returns 400, not 500, for a non-string prefix (coordinator's exact repro: normalizePrefix's .trim() used to 500 here)", async () => {
    const { POST } = await import("@/app/api/projects/route");
    const res = await POST(authedReq("http://localhost/api/projects", { method: "POST", body: { name: "Test", prefix: 123 } }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/prefix must be a non-empty string/i);
  });

  it("returns 400, not 500, for a non-string name", async () => {
    const { POST } = await import("@/app/api/projects/route");
    const res = await POST(authedReq("http://localhost/api/projects", { method: "POST", body: { name: 123, prefix: "CK" } }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/name must be a non-empty string/i);
  });

  it("still creates a valid project and returns 201", async () => {
    const { POST } = await import("@/app/api/projects/route");
    const res = await POST(authedReq("http://localhost/api/projects", { method: "POST", body: { name: "Cockpit", prefix: "ck" } }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.project.prefix).toBe("CK");
  });
});

describe("PUT /api/projects/[id]", () => {
  it("returns 400, not 500, for a non-string prefix", async () => {
    const p = makeProject("CK");
    const { PUT } = await import("@/app/api/projects/[id]/route");
    const res = await PUT(authedReq(`http://localhost/api/projects/${p.id}`, { method: "PUT", body: { prefix: 123 } }), {
      params: Promise.resolve({ id: p.id }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/prefix must be a non-empty string/i);
  });

  it("returns 400, not 500, for a non-string name", async () => {
    const p = makeProject("CK");
    const { PUT } = await import("@/app/api/projects/[id]/route");
    const res = await PUT(authedReq(`http://localhost/api/projects/${p.id}`, { method: "PUT", body: { name: 123 } }), {
      params: Promise.resolve({ id: p.id }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/name must be a non-empty string/i);
  });

  it("still applies a valid update and returns 200", async () => {
    const p = makeProject("CK");
    const { PUT } = await import("@/app/api/projects/[id]/route");
    const res = await PUT(authedReq(`http://localhost/api/projects/${p.id}`, { method: "PUT", body: { name: "Renamed" } }), {
      params: Promise.resolve({ id: p.id }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).project.name).toBe("Renamed");
  });
});
