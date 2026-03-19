import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { validateToken } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token =
    req.cookies.get("aperture_token")?.value ||
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
    const stdout = await run("gh", [
      "api",
      "user/orgs",
      "--jq",
      ".[].login",
    ]);
    const orgs = stdout.trim().split("\n").filter(Boolean);
    return NextResponse.json(orgs);
  } catch (err) {
    const msg = String(err);
    if (msg.includes("read:org") || msg.includes("403")) {
      return NextResponse.json(
        { error: "Missing read:org scope. Run 'gh auth refresh -s read:org' in your terminal." },
        { status: 403 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
