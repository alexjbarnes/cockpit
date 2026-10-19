// POST /api/filesystem/write — the save behind the files view's editor.
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));

import { POST } from "@/app/api/filesystem/write/route";

let root: string;

function write(body: unknown, token = "valid") {
  return POST(
    new NextRequest("http://localhost/api/filesystem/write", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `cockpit_session=${token}` },
      body: JSON.stringify(body),
    }),
  );
}

function seed(name: string, content: string): string {
  const file = path.join(root, name);
  writeFileSync(file, content);
  return file;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cockpit-fs-write-"));
});

describe("writing a file", () => {
  it("replaces the contents and reports the new mtime", async () => {
    const file = seed("notes.txt", "before");

    const res = await write({ path: file, content: "after" });

    expect(res.status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe("after");
    const body = await res.json();
    expect(body.mtimeMs).toBe(statSync(file).mtimeMs);
    expect(body.size).toBe(5);
    expect(readdirSync(root), "the temporary file goes with the write").toEqual(["notes.txt"]);
  });

  it("keeps the file's permissions", async () => {
    const file = seed("script.sh", "echo hi");
    chmodSync(file, 0o755);

    await write({ path: file, content: "echo bye" });

    expect(statSync(file).mode & 0o777).toBe(0o755);
  });

  it("writes through a symlink rather than replacing it", async () => {
    const target = seed("real.txt", "old");
    const link = path.join(root, "link.txt");
    symlinkSync(target, link);

    await write({ path: link, content: "new" });

    expect(readFileSync(target, "utf8")).toBe("new");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(link, "utf8"), "the link still points at the file it did").toBe("new");
  });

  it("refuses a file that changed on disk since it was read", async () => {
    const file = seed("live.txt", "disk");
    const stale = statSync(file).mtimeMs - 1000;

    const res = await write({ path: file, content: "mine", expectedMtimeMs: stale });

    expect(res.status).toBe(409);
    expect(readFileSync(file, "utf8"), "the other writer's text survives").toBe("disk");
    expect((await res.json()).mtimeMs).toBe(statSync(file).mtimeMs);
  });

  it("writes when the mtime still matches", async () => {
    const file = seed("mine.txt", "disk");
    const res = await write({ path: file, content: "mine", expectedMtimeMs: statSync(file).mtimeMs });

    expect(res.status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe("mine");
  });

  it("overwrites on request when the caller sends no mtime", async () => {
    const file = seed("conflict.txt", "theirs");
    const res = await write({ path: file, content: "mine" });

    expect(res.status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe("mine");
  });
});

describe("refusing to write", () => {
  it("refuses an unauthenticated caller", async () => {
    const file = seed("private.txt", "secret");
    const res = await write({ path: file, content: "changed" }, "nope");

    expect(res.status).toBe(401);
    expect(readFileSync(file, "utf8")).toBe("secret");
  });

  it("refuses without a path or content", async () => {
    expect((await write({ content: "x" })).status).toBe(400);
    expect((await write({ path: seed("a.txt", "a") })).status).toBe(400);
  });

  it("refuses a file that is not there", async () => {
    const res = await write({ path: path.join(root, "missing.txt"), content: "x" });

    expect(res.status).toBe(400);
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses a directory", async () => {
    const res = await write({ path: root, content: "x" });

    expect(res.status).toBe(400);
  });

  it("refuses a body over the 1MB backstop", async () => {
    const file = seed("big.txt", "small");
    const res = await write({ path: file, content: "x".repeat(1024 * 1024 + 1) });

    expect(res.status).toBe(413);
    expect(readFileSync(file, "utf8")).toBe("small");
  });
});
