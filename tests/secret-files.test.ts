// Secret files (.env, keys, tokens) are kept out of every file route.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));

import { GET as browse } from "@/app/api/filesystem/browse/route";
import { GET as files } from "@/app/api/filesystem/files/route";
import { GET as read } from "@/app/api/filesystem/read/route";
import { POST as writeRoute } from "@/app/api/filesystem/write/route";
import { GET as diff } from "@/app/api/git/diff/route";
import { isSecretPath } from "@/server/secret-files";
import { listSessionPaths } from "@/server/session-paths";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cockpit-secrets-"));
  tempDirs.push(dir);
  return dir;
}

function seed(root: string, relativePath: string, content = "x\n"): string {
  const full = path.join(root, relativePath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function get(url: string) {
  return new NextRequest(`http://localhost${url}`, { headers: { cookie: "cockpit_session=valid" } });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isSecretPath", () => {
  it.each([
    ".env",
    "app/.env",
    ".env.local",
    ".env.production",
    "deploy/prod.env",
    ".envrc",
    "/root/.ssh/config",
    "/root/.ssh",
    "home/.aws/credentials",
    "id_rsa",
    "id_ed25519",
    "certs/server.key",
    "/etc/letsencrypt/live/x/privkey.pem",
    "store.p12",
    "/home/me/.config/tool/api.token",
    "/root/.claude/.credentials.json",
    "secrets.yaml",
    "credentials.json",
    "client_secret_123.apps.googleusercontent.com.json",
    ".npmrc",
    ".pgpass",
    ".netrc",
    "/etc/shadow",
    "ENV/.ENV",
  ])("hides %s", (p) => {
    expect(isSecretPath(p)).toBe(true);
  });

  it.each([
    ".env.example",
    ".env.local.example",
    ".env.sample",
    ".env.template",
    "README.md",
    "src/environment.ts",
    "src/server/secret-files.ts",
    "id_rsa.pub",
    "docs/secrets-handling.md",
    "keyboard.ts",
    "tokens.css",
    "src/env.d.ts",
    "",
  ])("shows %s", (p) => {
    expect(isSecretPath(p)).toBe(false);
  });
});

describe("routes", () => {
  it("read refuses a secret file, also through a symlink, and still reads others", async () => {
    const root = tempDir();
    const env = seed(root, ".env", "API_KEY=hunter2\n");
    const notes = seed(root, "notes.txt", "hello");
    const link = path.join(root, "innocent.txt");
    symlinkSync(env, link);

    for (const p of [env, link]) {
      const res = await read(get(`/api/filesystem/read?path=${encodeURIComponent(p)}`));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.secret).toBe(true);
      expect(JSON.stringify(body)).not.toContain("hunter2");
    }

    const stat = await read(get(`/api/filesystem/read?path=${encodeURIComponent(env)}&stat=true`));
    expect(stat.status).toBe(403);

    const ok = await read(get(`/api/filesystem/read?path=${encodeURIComponent(notes)}`));
    expect(ok.status).toBe(200);
    expect((await ok.json()).content).toBe("hello");
  });

  it("write refuses a secret file and leaves it alone", async () => {
    const root = tempDir();
    const env = seed(root, ".env", "API_KEY=hunter2\n");
    const res = await writeRoute(
      new NextRequest("http://localhost/api/filesystem/write", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: "cockpit_session=valid" },
        body: JSON.stringify({ path: env, content: "gone" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(readFileSync(env, "utf8")).toBe("API_KEY=hunter2\n");
  });

  it("the tree, the file picker and the folder browser leave secrets out", async () => {
    const root = tempDir();
    seed(root, ".env");
    seed(root, ".env.example");
    seed(root, "src/app.ts");
    seed(root, "certs/server.key");
    seed(root, ".ssh/id_rsa");

    const tree = await listSessionPaths(root);
    expect(tree.paths).toEqual([".env.example", "src/app.ts"]);

    const picked = await (await files(get(`/api/filesystem/files?cwd=${encodeURIComponent(root)}`))).json();
    expect(picked.files.sort()).toEqual([".env.example", "src/app.ts"]);

    const listed = await (
      await browse(get(`/api/filesystem/browse?path=${encodeURIComponent(root)}&includeFiles=true&showHidden=true`))
    ).json();
    expect(listed.entries.map((e: { name: string }) => e.name).sort()).toEqual([".env.example", "certs", "src"]);

    const sshDir = await browse(get(`/api/filesystem/browse?path=${encodeURIComponent(path.join(root, ".ssh"))}`));
    expect(sshDir.status).toBe(403);
  });

  it("the tree leaves out ignored and tracked secrets in a git repository", async () => {
    const repo = tempDir();
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=it@example.com", "-c", "user.name=it", ...args], { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    seed(repo, ".gitignore", ".env\n");
    seed(repo, "config/prod.env");
    seed(repo, "main.py");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    seed(repo, ".env");

    const tree = await listSessionPaths(repo);
    expect(tree.paths).toEqual([".gitignore", "main.py"]);
  });

  it("diff refuses a secret file", async () => {
    const repo = tempDir();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: "ignore" });
    seed(repo, ".env", "API_KEY=hunter2\n");
    const res = await diff(get(`/api/git/diff?cwd=${encodeURIComponent(repo)}&file=.env`));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("hunter2");
  });
});
