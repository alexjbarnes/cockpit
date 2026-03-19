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

  // Check gh auth status first
  try {
    await run("gh", ["auth", "status"]);
  } catch {
    return NextResponse.json(
      { error: "GitHub CLI not authenticated. Run 'gh auth login' first." },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const owner = url.searchParams.get("owner");

  try {
    const args = ["repo", "list"];
    if (owner) args.push(owner);
    args.push(
      "--json",
      "name,nameWithOwner,description,primaryLanguage,pushedAt,isPrivate",
      "--limit",
      "100",
      "--no-archived",
    );

    const stdout = await run("gh", args);
    const repos = JSON.parse(stdout);
    return NextResponse.json(repos);
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 },
    );
  }
}
