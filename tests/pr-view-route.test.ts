import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth", () => ({
  validateSession: () => true,
}));

let execFileCalls: { cmd: string; args: string[] }[] = [];
let execFileResults: Map<string, string> = new Map();

vi.mock("node:child_process", () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    execFileCalls.push({ cmd, args });
    const key = args.join(" ");
    for (const [pattern, result] of execFileResults) {
      if (key.includes(pattern)) {
        cb(null, result);
        return;
      }
    }
    cb(new Error(`no mock for: ${key}`), "");
  },
}));

function makeReq(repo: string, number: string): NextRequest {
  return new NextRequest(`http://localhost/api/github/prs/view?repo=${repo}&number=${number}`, {
    headers: { cookie: "cockpit_session=valid" },
  });
}

describe("GET /api/github/prs/view", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileCalls = [];
    execFileResults = new Map();
  });

  it("returns mergeBaseSha from compare API", async () => {
    const prData = {
      title: "Test PR",
      headRefName: "feature",
      baseRefName: "main",
      headRefOid: "head-sha-111",
      baseRefOid: "base-sha-222",
    };
    execFileResults.set("pr view", JSON.stringify(prData));
    execFileResults.set("compare", "merge-base-sha-333\n");

    const { GET } = await import("@/app/api/github/prs/view/route");
    const res = await GET(makeReq("owner/repo", "42"));
    const body = await res.json();

    expect(body.mergeBaseSha).toBe("merge-base-sha-333");
    expect(body.headRefOid).toBe("head-sha-111");
    expect(body.baseRefOid).toBe("base-sha-222");
  });

  it("falls back to baseRefOid when compare API fails", async () => {
    const prData = {
      title: "Test PR",
      headRefName: "feature",
      baseRefName: "main",
      headRefOid: "head-sha-111",
      baseRefOid: "base-sha-222",
    };
    execFileResults.set("pr view", JSON.stringify(prData));
    // No compare mock -> will fail

    const { GET } = await import("@/app/api/github/prs/view/route");
    const res = await GET(makeReq("owner/repo", "42"));
    const body = await res.json();

    expect(body.mergeBaseSha).toBe("base-sha-222");
  });

  it("skips merge base fetch when refs are missing", async () => {
    const prData = {
      title: "Test PR",
      headRefName: "feature",
      baseRefName: "main",
    };
    execFileResults.set("pr view", JSON.stringify(prData));

    const { GET } = await import("@/app/api/github/prs/view/route");
    const res = await GET(makeReq("owner/repo", "42"));
    const body = await res.json();

    expect(body.mergeBaseSha).toBeUndefined();
  });

  it("returns 400 when repo or number missing", async () => {
    const { GET } = await import("@/app/api/github/prs/view/route");
    const req = new NextRequest("http://localhost/api/github/prs/view?repo=owner/repo", {
      headers: { cookie: "cockpit_session=valid" },
    });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });
});
