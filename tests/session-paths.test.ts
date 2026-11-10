import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSessionPaths } from "@/server/session-paths";

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
      paths: [".gitignore", ".idea/workspace.xml", "README.md", "ignored.txt", "src/a.ts", "src/b.ts"],
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
      paths: ["nested/two.ts", "one.ts", "secret.env"],
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

    expect(await listSessionPaths(root)).toEqual({ paths: ["notes/today.md", "readme.md"], ignored: [], truncated: false });
  });

  it("caps a large listing and says it was truncated", async () => {
    const root = tempDir();
    write(root, "a.txt");
    write(root, "b.txt");
    write(root, "c.txt");

    expect(await listSessionPaths(root, 2)).toEqual({ paths: ["a.txt", "b.txt"], ignored: [], truncated: true });
  });

  it("rejects a path that is not a directory", async () => {
    const root = tempDir();
    write(root, "file.txt");
    await expect(listSessionPaths(path.join(root, "file.txt"))).rejects.toThrow();
  });
});
