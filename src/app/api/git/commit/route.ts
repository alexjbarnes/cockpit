import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { validateSession, isAuthDisabled } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token =
    req.cookies.get("cockpit_session")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
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
  const { cwd, message, files, push } = body as {
    cwd: string;
    message: string;
    files: string[];
    push?: boolean;
  };

  if (!cwd || !message || !files?.length) {
    return NextResponse.json(
      { error: "cwd, message, and files are required" },
      { status: 400 }
    );
  }

  try {
    // Stage specified files
    await run("git", ["add", "--", ...files], cwd);

    // Commit
    await run("git", ["commit", "-m", message], cwd);

    // Push if requested
    if (push) {
      await run("git", ["push"], cwd);
    }

    return NextResponse.json({ ok: true, pushed: !!push });
  } catch (err) {
    const message_ = err instanceof Error ? err.message : "Failed to commit";
    return NextResponse.json({ error: message_ }, { status: 500 });
  }
}
