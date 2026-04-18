import { execFile } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { isAuthDisabled, validateSession } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { cwd } = body as { cwd: string };

  if (!cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }

  try {
    await run("git", ["push"], cwd);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to push";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
