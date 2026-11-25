import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSessionDirectory, listSessionPaths } from "@/server/session-paths";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cockpit-tree-"));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=it@example.com", "-c", "user.name=it", ...args], { cwd, stdio: "ignore" });
}

function write(root: string, relativePath: string, content = "x\n"): void {
  const full = path.join(root, relativePath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("listSessionPaths", () => {
  it("lists tracked and untracked files, marks ignored ones and prunes generated folders", async () => {
    const repo = tempDir();
    git(repo, "init", "-q", "-b", "main");
    write(repo, ".gitignore", "dist/\nignored.txt\nnode_modules/\n.idea/\n");
    write(repo, "src/a.ts");
    write(repo, "README.md");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");

    write(repo, "src/b.ts");
    write(repo, "ignored.txt");
    write(repo, ".idea/workspace.xml");
    write(repo, "dist/out.js");
    write(repo, "node_modules/pkg/index.js");

    expect(await listSessionPaths(repo)).toEqual({
      paths: [".gitignore", "ignored.txt", "README.md", ".idea/workspace.xml", "src/a.ts", "src/b.ts"],
      ignored: [".idea/workspace.xml", "ignored.txt"],
      truncated: false,
    });
  });

  it("returns paths relative to a session that starts in a subdirectory", async () => {
    const repo = tempDir();
    git(repo, "init", "-q", "-b", "main");
    write(repo, ".gitignore", "src/secret.env\n");
    write(repo, "src/one.ts");
    write(repo, "src/nested/two.ts");
    write(repo, "other/three.ts");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    write(repo, "src/secret.env");

    expect(await listSessionPaths(path.join(repo, "src"))).toEqual({
      paths: ["one.ts", "secret.env", "nested/two.ts"],
      ignored: ["secret.env"],
      truncated: false,
    });
  });

  it("walks a folder that is not a git repository, skipping heavy folders", async () => {
    const root = tempDir();
    write(root, "readme.md");
    write(root, "notes/today.md");
    write(root, "node_modules/pkg/index.js");
    write(root, "dist/out.js");
    write(root, ".git/config");
    symlinkSync(root, path.join(root, "loop"));

    expect(await listSessionPaths(root)).toEqual({ paths: ["readme.md", "notes/today.md"], ignored: [], truncated: false });
  });

  it("caps a large listing and says it was truncated", async () => {
    const root = tempDir();
    write(root, "a.txt");
    write(root, "b.txt");
    write(root, "c.txt");

    expect(await listSessionPaths(root, 2)).toEqual({ paths: ["a.txt", "b.txt"], ignored: [], truncated: true });
  });

  it("keeps shallow files when a deep tool folder would fill the cap", async () => {
    const root = tempDir();
    write(root, "README.md");
    write(root, "src/app.ts");
    for (let i = 0; i < 20; i++) write(root, `.claude/deep/f${i}.txt`);
    write(root, ".playwright-mcp/shot.png");
    write(root, ".worktrees/other/file.txt");

    const listing = await listSessionPaths(root, 5);

    expect(listing.paths.slice(0, 2)).toEqual(["README.md", "src/app.ts"]);
    expect(listing.paths.some((entry) => entry.startsWith(".playwright-mcp/") || entry.startsWith(".worktrees/"))).toBe(false);
    expect(listing.truncated).toBe(true);
  });

  it("lists one directory at a time for the lazy Files tree", async () => {
    const repo = tempDir();
    git(repo, "init", "-q", "-b", "main");
    write(repo, ".gitignore", "ignored.txt\n");
    write(repo, "README.md");
    write(repo, "src/a.ts");
    write(repo, "ignored.txt");
    write(repo, "node_modules/pkg/index.js");
    write(repo, ".playwright-mcp/shot.png");
    write(repo, ".worktrees/other/file.txt");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");

    const root = await listSessionDirectory(repo);
    expect(root.paths).toEqual([".gitignore", "ignored.txt", "README.md", "src/"]);
    expect(root.ignored).toEqual(["ignored.txt"]);

    const sub = await listSessionDirectory(repo, "src");
    expect(sub.paths).toEqual(["src/a.ts"]);

    await expect(listSessionDirectory(repo, "../outside")).rejects.toThrow();
  });

  it("rejects a path that is not a directory", async () => {
    const root = tempDir();
    write(root, "file.txt");
    await expect(listSessionPaths(path.join(root, "file.txt"))).rejects.toThrow();
  });
});
