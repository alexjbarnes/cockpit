// src/server/gh.ts is the shared half of the /api/github routes: authenticate,
// run `gh`, and hold the successful reads in memory. These tests put a
// stand-in `gh` on PATH, so what is asserted is the real behaviour — a second
// identical read is not a second process, a failure is never stored, and a
// bypass runs the command again.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));

import { authenticate, invalidateGhReads, invalidateGhReadsByPrefix, run, runCached, wantsFreshData } from "@/server/gh";

let dir: string;
let keyCounter = 0;

/** The cache lives as long as the server does, so each test takes its own keys. */
function key(prefix: string): string {
  keyCounter += 1;
  return `${prefix}:${keyCounter}`;
}

/** Replace `gh` with a shell script that does what the test needs. */
function fakeGh(body: string): void {
  writeFileSync(path.join(dir, "gh"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** How many times the stand-in gh has run. */
function runs(): number {
  return Number(readFileSync(path.join(dir, "count"), "utf8").trim());
}

/** A gh that numbers its runs, so a repeat can be told from a cache hit. */
function countingGh(): void {
  fakeGh([`n=$(cat "${dir}/count" 2>/dev/null || echo 0)`, "n=$((n + 1))", `echo "$n" > "${dir}/count"`, 'echo "reading-$n"'].join("\n"));
}

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/github/prs", { headers });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cockpit-gh-"));
  vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("running gh", () => {
  it("resolves with what the command wrote", async () => {
    fakeGh("echo hello");
    await expect(run(["pr", "list"])).resolves.toBe("hello\n");
  });

  it("rejects when gh exits non-zero", async () => {
    fakeGh("echo boom >&2\nexit 2");
    await expect(run(["pr", "list"])).rejects.toThrow(/boom/);
  });

  it("keeps the stdout of a killed gh only when the caller asked for it", async () => {
    // `gh pr diff` writes a truncated diff and then dies; the fallback below
    // it needs the part that was written.
    fakeGh("echo partial\nkill -TERM $$");
    await expect(run(["pr", "diff"])).rejects.toThrow();
    await expect(run(["pr", "diff"], { allowStdoutOnError: true })).resolves.toBe("partial\n");
  });
});

describe("cached reads", () => {
  it("serves a repeat from memory instead of running gh again", async () => {
    countingGh();
    const k = key("prs:o/r:open");

    await expect(runCached(k, 60_000, ["pr", "list"])).resolves.toBe("reading-1\n");
    await expect(runCached(k, 60_000, ["pr", "list"])).resolves.toBe("reading-1\n");
    expect(runs(), "the second read never reached the CLI").toBe(1);

    await expect(runCached(k, 60_000, ["pr", "list"], { bypass: true })).resolves.toBe("reading-2\n");
    expect(runs(), "a bypass asks gh again").toBe(2);
  });

  it("stores nothing when gh fails, so the user's retry really retries", async () => {
    fakeGh(
      [`if [ ! -f "${dir}/seen" ]; then`, `  touch "${dir}/seen"`, '  echo "not yet" >&2', "  exit 1", "fi", 'echo "ready"'].join("\n"),
    );
    const k = key("checks:o/r:1");

    await expect(runCached(k, 60_000, ["pr", "checks"])).rejects.toThrow(/not yet/);
    await expect(runCached(k, 60_000, ["pr", "checks"])).resolves.toBe("ready\n");
  });

  it("does not hold on to a read too large to be worth it", async () => {
    fakeGh(
      [
        `n=$(cat "${dir}/count" 2>/dev/null || echo 0)`,
        "n=$((n + 1))",
        `echo "$n" > "${dir}/count"`,
        "head -c 1200000 /dev/zero | tr '\\0' x",
        'echo "$n"',
      ].join("\n"),
    );
    const k = key("diff:o/r:9");

    const first = await runCached(k, 60_000, ["pr", "diff"]);
    expect(first.length, "the read really is over the limit").toBeGreaterThan(1024 * 1024);

    await runCached(k, 60_000, ["pr", "diff"]);
    expect(runs(), "an oversized answer is not kept, so gh runs again").toBe(2);
  });
});

describe("forgetting reads a write has made wrong", () => {
  it("drops one key", async () => {
    countingGh();
    const k = key("pr:o/r:1");

    await runCached(k, 60_000, ["pr", "view"]);
    invalidateGhReads(k);
    await expect(runCached(k, 60_000, ["pr", "view"])).resolves.toBe("reading-2\n");
  });

  it("drops a repo's PR lists by prefix and leaves an unrelated read alone", async () => {
    countingGh();
    const open = key("prs:o/r");
    const closed = key("prs:o/r");
    const other = key("pr:o/r");

    await runCached(open, 60_000, ["pr", "list"]);
    await runCached(closed, 60_000, ["pr", "list"]);
    await runCached(other, 60_000, ["pr", "view"]);
    expect(runs()).toBe(3);

    invalidateGhReadsByPrefix("prs:o/r:");

    await runCached(open, 60_000, ["pr", "list"]);
    await runCached(closed, 60_000, ["pr", "list"]);
    await runCached(other, 60_000, ["pr", "view"]);
    expect(runs(), "the two lists ran again; the PR itself did not").toBe(5);
  });
});

describe("what a route asks the shared helper", () => {
  it("recognises a request that wants a reading taken now", () => {
    expect(wantsFreshData(request({ "cache-control": "no-cache" }))).toBe(true);
    expect(wantsFreshData(request({ "cache-control": "no-store" }))).toBe(true);
    expect(wantsFreshData(request({ "cache-control": "max-age=0" }))).toBe(true);
    expect(wantsFreshData(request({ "cache-control": "max-age=60" }))).toBe(false);
    expect(wantsFreshData(request())).toBe(false);
  });

  it("takes a session cookie or a bearer token, and nothing else", () => {
    expect(authenticate(request({ cookie: "cockpit_session=valid" }))).toBe(true);
    expect(authenticate(request({ authorization: "Bearer valid" }))).toBe(true);
    expect(authenticate(request({ cookie: "cockpit_session=nope" }))).toBe(false);
    expect(authenticate(request({ authorization: "Bearer nope" }))).toBe(false);
    expect(authenticate(request())).toBe(false);
  });
});
