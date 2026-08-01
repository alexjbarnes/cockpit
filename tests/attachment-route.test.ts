// The attachment-serving route treats an attachment's url as untrusted: a
// session or job wrote it through the MCP tool, so serving whatever path it
// names would turn add_issue_attachment into a read-any-file primitive
// (attach /home/dev/.cockpit/auth.json, then GET it back through the UI).
// Only files under getIssueAttachmentsRoot() are served. Handlers are called
// directly against real issue-storage and a tmpdir, mirroring
// tests/issue-routes.test.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addIssueAttachment, buildIssue, buildProject, saveIssue, saveProject } from "@/server/issue-storage";
import { getIssueAttachmentsRoot } from "@/server/paths";
import type { Issue } from "@/types";

vi.mock("@/server/auth", () => ({
  validateSession: () => true,
}));

import { GET } from "@/app/api/issues/[key]/attachments/[id]/route";

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cockpit-attach-"));
  prevConfigDir = process.env.COCKPIT_CONFIG_DIR;
  process.env.COCKPIT_CONFIG_DIR = dir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.COCKPIT_CONFIG_DIR;
  else process.env.COCKPIT_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

const ACTOR = { kind: "user" as const };

function makeIssueWithAttachment(url: string): { issue: Issue; attachmentId: string } {
  const project = buildProject({ name: "Cockpit", prefix: "CK" });
  saveProject(project);
  const base = buildIssue({ projectId: project.id, title: "with attachment" }, ACTOR);
  const withAttachment = addIssueAttachment(base, { title: "screenshot", url }, ACTOR);
  saveIssue(withAttachment);
  return { issue: withAttachment, attachmentId: withAttachment.attachments[0].id };
}

function req(key: string, id: string, authed = true) {
  const r = new NextRequest(`http://localhost/api/issues/${key}/attachments/${id}`, {
    headers: authed ? { cookie: "cockpit_session=valid" } : {},
  });
  return GET(r, { params: Promise.resolve({ key, id }) });
}

describe("GET /api/issues/[key]/attachments/[id]", () => {
  it("serves a file stored under the attachments root, with its content type", async () => {
    const root = path.join(getIssueAttachmentsRoot(), "CK-1");
    mkdirSync(root, { recursive: true });
    const file = path.join(root, "shot.jpg");
    writeFileSync(file, "jpegbytes");

    const { issue, attachmentId } = makeIssueWithAttachment(file);
    const res = await req(issue.key, attachmentId);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(await res.text()).toBe("jpegbytes");
  });

  it("refuses a file outside the attachments root even though it exists", async () => {
    const secret = path.join(dir, "auth.json");
    writeFileSync(secret, "hash");

    const { issue, attachmentId } = makeIssueWithAttachment(secret);
    const res = await req(issue.key, attachmentId);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("hash");
  });

  it("refuses a traversal url that resolves outside the root", async () => {
    const evil = path.join(getIssueAttachmentsRoot(), "..", "auth.json");
    writeFileSync(path.join(dir, "auth.json"), "hash");

    const { issue, attachmentId } = makeIssueWithAttachment(evil);
    const res = await req(issue.key, attachmentId);
    expect(res.status).toBe(404);
  });

  it("404s an unknown issue key and an unknown attachment id", async () => {
    const { issue } = makeIssueWithAttachment(path.join(getIssueAttachmentsRoot(), "x.jpg"));
    expect((await req("ZZ-9", "nope")).status).toBe(404);
    expect((await req(issue.key, "nope")).status).toBe(404);
  });

  it("404s cleanly when the attached file no longer exists on disk", async () => {
    const gone = path.join(getIssueAttachmentsRoot(), "CK-1", "gone.jpg");
    const { issue, attachmentId } = makeIssueWithAttachment(gone);
    const res = await req(issue.key, attachmentId);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("no longer exists");
  });

  it("rejects a request with no session cookie", async () => {
    const { issue, attachmentId } = makeIssueWithAttachment(path.join(getIssueAttachmentsRoot(), "x.jpg"));
    expect((await req(issue.key, attachmentId, false)).status).toBe(401);
  });
});
