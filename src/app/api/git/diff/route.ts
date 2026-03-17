import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { validateToken } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token =
    req.cookies.get("aperture_token")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateToken(token);
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err && !(err as NodeJS.ErrnoException).code && stdout) {
        // git diff exits with code 1 when there are differences
        resolve(stdout);
      } else if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");
  const file = url.searchParams.get("file");
  if (!cwd || !file) {
    return NextResponse.json({ error: "cwd and file are required" }, { status: 400 });
  }

  try {
    let diff = "";
    // Try tracked file diff first (staged + unstaged vs HEAD)
    try {
      diff = await run("git", ["diff", "HEAD", "--", file], cwd);
    } catch {
      // Might fail on initial commit
      try {
        diff = await run("git", ["diff", "--cached", "--", file], cwd);
      } catch {
        // no diff available
      }
    }

    // If no diff, the file might be untracked - show full content as addition
    if (!diff) {
      try {
        const content = await run("git", ["show", `:${file}`], cwd);
        // File is staged but no HEAD to diff against
        const lines = content.split("\n");
        diff = [
          `--- /dev/null`,
          `+++ b/${file}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...lines.map((l) => `+${l}`),
        ].join("\n");
      } catch {
        // Truly untracked - read from filesystem
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        try {
          const content = await readFile(join(cwd, file), "utf-8");
          const lines = content.split("\n");
          diff = [
            `--- /dev/null`,
            `+++ b/${file}`,
            `@@ -0,0 +1,${lines.length} @@`,
            ...lines.map((l) => `+${l}`),
          ].join("\n");
        } catch {
          return NextResponse.json({ error: "File not found" }, { status: 404 });
        }
      }
    }

    return NextResponse.json({ diff });
  } catch {
    return NextResponse.json({ error: "Failed to get diff" }, { status: 500 });
  }
}
