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

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
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
  const { repo, number, action, body: reviewBody } = body as {
    repo?: string;
    number?: number;
    action?: string;
    body?: string;
  };

  if (!repo || !number || !action) {
    return NextResponse.json(
      { error: "repo, number, and action are required" },
      { status: 400 },
    );
  }

  const flagMap: Record<string, string> = {
    approve: "--approve",
    "request-changes": "--request-changes",
    comment: "--comment",
  };

  const flag = flagMap[action];
  if (!flag) {
    return NextResponse.json(
      { error: `Invalid action: ${action}. Must be approve, request-changes, or comment` },
      { status: 400 },
    );
  }

  const args = ["pr", "review", String(number), "-R", repo, flag];
  if (reviewBody) {
    args.push("--body", reviewBody);
  }

  try {
    await run("gh", args);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 },
    );
  }
}
