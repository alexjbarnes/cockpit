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

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const repo = url.searchParams.get("repo");
  const path = url.searchParams.get("path");
  const ref = url.searchParams.get("ref");

  if (!repo || !path || !ref) {
    return NextResponse.json(
      { error: "repo, path, and ref are required" },
      { status: 400 },
    );
  }

  try {
    const content = await run("gh", [
      "api",
      `repos/${repo}/contents/${path}?ref=${ref}`,
      "--jq", ".content",
    ]);
    const decoded = Buffer.from(content.trim(), "base64").toString("utf-8");
    return NextResponse.json({ content: decoded });
  } catch {
    // File may not exist at this ref (new file or deleted file)
    return NextResponse.json({ content: null });
  }
}
