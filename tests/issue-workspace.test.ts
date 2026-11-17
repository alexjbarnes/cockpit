// An issue's own worktree, against real git in a tmpdir: made from the right
// base, kept across calls, brought back with its work, and removed.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspace, removeWorkspace, workspaceBranch, workspaceRoot } from "@/server/issue-workspace";
import { heldRunPorts, releaseRunPorts, reserveRunPort } from "@/server/run-ports";
import type { Project } from "@/types";

let dir: string;
let repo: string;
let prevConfigDir: string | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf-8" }).trim();
}

function project(over: Partial<Project> = {}): Project {
  return { id: "p1", name: "Cockpit", prefix: "CK", repoPath: repo, createdAt: 0, updatedAt: 0, nextNumber: 1, ...over };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cockpit-workspace-"));
  repo = path.join(dir, "cockpit");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "main\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  prevConfigDir = process.env.COCKPIT_CONFIG_DIR;
  process.env.COCKPIT_CONFIG_DIR = path.join(dir, "config");
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.COCKPIT_CONFIG_DIR;
  else process.env.COCKPIT_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("an issue's worktree", () => {
  it("is made on the issue's own branch, from what the repository is on", async () => {
    const ws = await ensureWorkspace(project(), { key: "ck-7" });
    expect(ws.branch).toBe("issue/CK-7");
    expect(ws.base).toBe("HEAD");
    expect(ws.path).toBe(path.join(workspaceRoot(), "cockpit-CK-7"));
    expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("issue/CK-7");
    expect(existsSync(path.join(ws.path, "README.md"))).toBe(true);
    expect(workspaceBranch("ck-7")).toBe("issue/CK-7");
  });

  it("starts from the project's base branch when it names one", async () => {
    git(repo, "checkout", "-q", "-b", "next");
    writeFileSync(path.join(repo, "next.txt"), "next\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "next");
    git(repo, "checkout", "-q", "main");

    const ws = await ensureWorkspace(project({ baseBranch: "next" }), { key: "CK-1" });
    expect(ws.base).toBe("next");
    expect(existsSync(path.join(ws.path, "next.txt"))).toBe(true);
    await expect(ensureWorkspace(project({ baseBranch: "nope" }), { key: "CK-2" })).rejects.toThrow(/base branch "nope" does not exist/);
  });

  it("starts from the remote's copy of the base branch, and from its default with none named", async () => {
    const origin = path.join(dir, "origin.git");
    git(dir, "clone", "-q", "--bare", repo, origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "fetch", "-q", "origin");
    git(repo, "remote", "set-head", "origin", "main");
    // The local main moves on; the remote's has not.
    writeFileSync(path.join(repo, "local-only.txt"), "x\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "local");

    const named = await ensureWorkspace(project({ baseBranch: "main" }), { key: "CK-1" });
    expect(named.base).toBe("origin/main");
    expect(existsSync(path.join(named.path, "local-only.txt"))).toBe(false);
    const unnamed = await ensureWorkspace(project(), { key: "CK-2" });
    expect(unnamed.base).toBe("origin/main");
  });

  it("prefers origin/main when the clone has no origin/HEAD", async () => {
    const origin = path.join(dir, "origin.git");
    git(dir, "clone", "-q", "--bare", repo, origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "fetch", "-q", "origin");
    // No set-head: refs/remotes/origin/HEAD is not a symbolic ref, which is
    // the state a plain clone can be in. The remote's branch beats HEAD.

    const ws = await ensureWorkspace(project(), { key: "CK-1" });
    expect(ws.base).toBe("origin/main");
  });

  it("fails loudly when the base cannot be fetched, rather than using a stale ref", async () => {
    git(repo, "remote", "add", "origin", path.join(dir, "gone.git"));
    await expect(ensureWorkspace(project({ baseBranch: "main" }), { key: "CK-1" })).rejects.toThrow(/Could not fetch "main" from origin/);
  });

  it("brings a clean worktree up to date with the base before the next stage", async () => {
    const origin = path.join(dir, "origin.git");
    git(dir, "clone", "-q", "--bare", repo, origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "fetch", "-q", "origin");
    git(repo, "remote", "set-head", "origin", "main");

    const first = await ensureWorkspace(project({ baseBranch: "main" }), { key: "CK-1" });
    // Main moves on after the worktree was cut.
    writeFileSync(path.join(repo, "later.txt"), "later\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "later");
    git(repo, "push", "-q", origin, "main");

    const again = await ensureWorkspace(project({ baseBranch: "main" }), { key: "CK-1", workspace: first });
    expect(again.path).toBe(first.path);
    expect(existsSync(path.join(first.path, "later.txt"))).toBe(true);
  });

  it("leaves a worktree with uncommitted work alone", async () => {
    const origin = path.join(dir, "origin.git");
    git(dir, "clone", "-q", "--bare", repo, origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "fetch", "-q", "origin");
    git(repo, "remote", "set-head", "origin", "main");

    const first = await ensureWorkspace(project({ baseBranch: "main" }), { key: "CK-1" });
    writeFileSync(path.join(first.path, "draft.txt"), "draft\n");
    writeFileSync(path.join(repo, "later.txt"), "later\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "later");
    git(repo, "push", "-q", origin, "main");

    await ensureWorkspace(project({ baseBranch: "main" }), { key: "CK-1", workspace: first });
    expect(existsSync(path.join(first.path, "draft.txt"))).toBe(true);
    expect(existsSync(path.join(first.path, "later.txt"))).toBe(false);
  });

  it("is kept across calls, and several can be made at once in one repository", async () => {
    const made = await Promise.all(["CK-1", "CK-2", "CK-3"].map((key) => ensureWorkspace(project(), { key })));
    expect(new Set(made.map((w) => w.path)).size).toBe(3);
    for (const w of made) expect(existsSync(path.join(w.path, ".git"))).toBe(true);

    writeFileSync(path.join(made[0].path, "work.txt"), "work\n");
    const again = await ensureWorkspace(project(), { key: "CK-1", workspace: made[0] });
    expect(again).toBe(made[0]);
    // Known by its path even when the issue has lost the record of it.
    const found = await ensureWorkspace(project(), { key: "CK-1" });
    expect(found.path).toBe(made[0].path);
    expect(existsSync(path.join(found.path, "work.txt"))).toBe(true);
  });

  it("comes back with its committed work after being removed", async () => {
    const first = await ensureWorkspace(project(), { key: "CK-1" });
    writeFileSync(path.join(first.path, "work.txt"), "work\n");
    git(first.path, "add", ".");
    git(first.path, "commit", "-q", "-m", "work");

    await removeWorkspace(project(), first);
    expect(existsSync(first.path)).toBe(false);
    // The branch is the record of the work, and is left.
    expect(git(repo, "branch", "--list", "issue/CK-1")).toContain("issue/CK-1");

    const second = await ensureWorkspace(project(), { key: "CK-1", workspace: first });
    expect(second.path).toBe(first.path);
    expect(existsSync(path.join(second.path, "work.txt"))).toBe(true);
  });

  it("is refused for a project with no repository, or a folder that is not one", async () => {
    await expect(ensureWorkspace(project({ repoPath: undefined }), { key: "CK-1" })).rejects.toThrow(/no repository folder/);
    await expect(ensureWorkspace(project({ repoPath: path.join(dir, "gone") }), { key: "CK-1" })).rejects.toThrow(/no repository folder/);
    const plain = path.join(dir, "plain");
    mkdirSync(plain);
    await expect(ensureWorkspace(project({ repoPath: plain }), { key: "CK-1" })).rejects.toThrow(/not a git repository/);
  });

  it("is removed without complaint when there is nothing to remove", async () => {
    const ws = { path: path.join(dir, "never"), branch: "issue/CK-9", base: "HEAD", createdAt: 1 };
    await expect(removeWorkspace(project(), ws)).resolves.toBeUndefined();
    await expect(removeWorkspace(undefined, ws)).resolves.toBeUndefined();
    await expect(removeWorkspace(project({ repoPath: path.join(dir, "gone") }), ws)).resolves.toBeUndefined();
  });
});

describe("a run's port", () => {
  it("is different for every run that holds one, and free again once given back", () => {
    const before = heldRunPorts();
    const a = reserveRunPort("run-a");
    const b = reserveRunPort("run-b");
    const c = reserveRunPort("run-a");
    expect(new Set([a, b, c]).size).toBe(3);
    for (const port of [a, b, c]) {
      expect(port).toBeGreaterThanOrEqual(42_000);
      expect(port).toBeLessThanOrEqual(42_999);
    }
    expect(heldRunPorts()).toBe(before + 3);
    releaseRunPorts("run-a");
    expect(heldRunPorts()).toBe(before + 1);
    releaseRunPorts("run-b");
    releaseRunPorts("run-nobody");
    expect(heldRunPorts()).toBe(before);
  });

  it("wraps round the range, skips what is held and says when none is left", () => {
    const holders: string[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      holders.push(`h${i}`);
      seen.add(reserveRunPort(`h${i}`));
    }
    expect(seen.size).toBe(1000);
    expect(() => reserveRunPort("one-too-many")).toThrow(/No port is free/);
    releaseRunPorts("h500");
    expect(seen.has(reserveRunPort("late"))).toBe(true);
    releaseRunPorts("late");
    for (const h of holders) releaseRunPorts(h);
    expect(heldRunPorts()).toBe(0);
  });
});
