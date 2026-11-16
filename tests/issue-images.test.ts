// Pictures in an issue's comments and plan: a file an agent names is copied
// into the issue and its target swapped for the address the page loads, and an
// agent reading the issue is given the stored file back. Real issue-storage
// against a tmpdir.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { embedImages, INLINE_IMAGE_MAX_BYTES, imagesForAgent } from "@/server/issue-images";
import { addIssueAttachment, buildIssue, buildProject, saveIssue, saveProject } from "@/server/issue-storage";
import { getIssueAttachmentsRoot } from "@/server/paths";
import type { Issue } from "@/types";

let dir: string;
let prevConfigDir: string | undefined;
let issue: Issue;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cockpit-images-"));
  prevConfigDir = process.env.COCKPIT_CONFIG_DIR;
  process.env.COCKPIT_CONFIG_DIR = dir;
  const project = buildProject({ name: "Cockpit", prefix: "CK" });
  saveProject(project);
  issue = buildIssue({ projectId: project.id, title: "pictures" }, { kind: "user" });
  saveIssue(issue);
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.COCKPIT_CONFIG_DIR;
  else process.env.COCKPIT_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

function shot(name: string, bytes = name): string {
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

describe("embedImages", () => {
  it("copies a named file into the issue and points the image at where the page loads it", () => {
    const src = shot("phone.png");
    const result = embedImages(issue, `Built it.\n\n![Phone width](${src})`, 123);

    expect(result.issue.attachments).toHaveLength(1);
    const [a] = result.issue.attachments;
    expect(a).toMatchObject({ title: "Phone width", inline: true, createdAt: 123 });
    expect(a.url.startsWith(path.join(getIssueAttachmentsRoot(), "CK-1"))).toBe(true);
    expect(readFileSync(a.url, "utf-8")).toBe("phone.png");
    expect(result.markdown).toBe(`Built it.\n\n![Phone width](/api/issues/CK-1/attachments/${a.id})`);
    // Nothing is added to the activity: the comment or plan it sits in says so.
    expect(result.issue.activity).toEqual(issue.activity);
  });

  it("outlives the file it was given", () => {
    const src = shot("gone.png");
    const result = embedImages(issue, `![x](${src})`);
    rmSync(src);
    expect(existsSync(result.issue.attachments[0].url)).toBe(true);
  });

  it("titles a picture with no caption by its file name", () => {
    const result = embedImages(issue, `![](${shot("untitled.webp")})`);
    expect(result.issue.attachments[0].title).toBe("untitled.webp");
  });

  it("stores a picture named twice in one text once", () => {
    const src = shot("twice.png");
    const result = embedImages(issue, `![a](${src}) ![b](${src})`);
    expect(result.issue.attachments).toHaveLength(1);
    const href = `/api/issues/CK-1/attachments/${result.issue.attachments[0].id}`;
    expect(result.markdown).toBe(`![a](${href}) ![b](${href})`);
  });

  it("stores the same picture once across texts, so a plan sent again reads the same", () => {
    const src = shot("mock.png", "same bytes");
    const first = embedImages(issue, `![Option A](${src})`);
    const copy = shot("mock-copy.png", "same bytes");
    const second = embedImages(first.issue, `![Option A](${copy})`);
    expect(second.issue).toBe(first.issue);
    expect(second.markdown).toBe(first.markdown);
  });

  it("reuses an attachment the issue already holds at that path", () => {
    const root = path.join(getIssueAttachmentsRoot(), "CK-1");
    mkdirSync(root, { recursive: true });
    const stored = path.join(root, "reviewer.png");
    writeFileSync(stored, "bytes");
    const attached = addIssueAttachment(issue, { title: "From the reviewer", url: stored }, { kind: "user" });
    const result = embedImages(attached, `![Reviewer](${stored})`);
    expect(result.issue).toBe(attached);
    expect(result.markdown).toBe(`![Reviewer](/api/issues/CK-1/attachments/${attached.attachments[0].id})`);
  });

  it("reads a file: address and a path under the home directory", () => {
    const viaUrl = embedImages(issue, `![x](${pathToFileURL(shot("url.png")).href})`);
    expect(viaUrl.issue.attachments).toHaveLength(1);
    // Nothing is at this path, which shows it was read as a file under home.
    expect(() => embedImages(issue, "![x](~/cockpit-no-such-dir/shot.png)")).toThrow(/does not exist/);
    expect(homedir()).toBeTruthy();
  });

  it("leaves a link, a data address and an address Cockpit already serves as written", () => {
    const md = "![a](https://example.com/a.png) ![b](data:image/png;base64,AAAA) ![c](/api/issues/CK-1/attachments/abc)";
    const result = embedImages(issue, md);
    expect(result.issue).toBe(issue);
    expect(result.markdown).toBe(md);
  });

  it("leaves text with no images untouched", () => {
    const result = embedImages(issue, "Nothing to see. `![not](/tmp/an-image.png)`");
    expect(result.issue).toBe(issue);
    expect(result.markdown).toBe("Nothing to see. `![not](/tmp/an-image.png)`");
  });

  it("refuses a relative path, saying why", () => {
    expect(() => embedImages(issue, "![x](shots/a.png)")).toThrow(/absolute path/);
  });

  it("refuses a file that is not an image", () => {
    const secret = shot("auth.json", "{}");
    expect(() => embedImages(issue, `![x](${secret})`)).toThrow(/Only images/);
    expect(() => embedImages(issue, `![x](${shot("drawing.svg")})`)).toThrow(/Only images/);
  });

  it("refuses a missing file and a directory", () => {
    expect(() => embedImages(issue, `![x](${path.join(dir, "missing.png")})`)).toThrow(/does not exist/);
    mkdirSync(path.join(dir, "folder.png"));
    expect(() => embedImages(issue, `![x](${path.join(dir, "folder.png")})`)).toThrow(/does not exist/);
  });

  it("refuses a file over the size limit", () => {
    const big = shot("big.png", "");
    truncateSync(big, INLINE_IMAGE_MAX_BYTES + 1);
    expect(() => embedImages(issue, `![x](${big})`)).toThrow(/larger than 20 MB/);
  });
});

describe("imagesForAgent", () => {
  it("names a stored picture by its file, and embedding that again gives the same text back", () => {
    const stored = embedImages(issue, `![Option A](${shot("a.png")})`);
    const forAgent = imagesForAgent(stored.issue, stored.markdown);
    expect(forAgent).toBe(`![Option A](${stored.issue.attachments[0].url})`);

    const again = embedImages(stored.issue, forAgent);
    expect(again.issue).toBe(stored.issue);
    expect(again.markdown).toBe(stored.markdown);
  });

  it("leaves anything that is not one of the issue's stored files", () => {
    const remote = addIssueAttachment(issue, { title: "Remote", url: "https://example.com/a.png" }, { kind: "user" });
    const id = remote.attachments[0].id;
    const md = `![a](/api/issues/CK-1/attachments/${id}) ![b](/api/issues/CK-1/attachments/unknown) ![c](https://example.com/c.png)`;
    expect(imagesForAgent(remote, md)).toBe(md);
  });
});
