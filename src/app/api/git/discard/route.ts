import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { validateToken } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token =
    req.cookies.get("cockpit_token")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateToken(token);
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { cwd, file, status } = body as { cwd: string; file: string; status: string };
  if (!cwd || !file) {
    return NextResponse.json({ error: "cwd and file are required" }, { status: 400 });
  }

  try {
    if (status === "untracked") {
      // Remove untracked file
      const { unlink } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await unlink(join(cwd, file));
    } else {
      // Unstage if staged
      try {
        await run("git", ["reset", "HEAD", "--", file], cwd);
      } catch {
        // might not be staged
      }
      // Restore to HEAD
      await run("git", ["checkout", "HEAD", "--", file], cwd);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to discard";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
