import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { validateToken } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token =
    req.cookies.get("cockpit_token")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateToken(token);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Always include the authenticated user's personal account
    const userOut = await run("gh", ["api", "user", "--jq", ".login"]);
    const username = userOut.trim();

    let orgs: string[] = [];
    try {
      const stdout = await run("gh", ["api", "user/orgs", "--jq", ".[].login"]);
      orgs = stdout.trim().split("\n").filter(Boolean);
    } catch {
      // read:org scope may be missing, continue with just the personal account
    }

    // Personal account first, then orgs
    const result = [username, ...orgs.filter((o) => o !== username)];
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
