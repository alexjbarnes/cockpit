import { execFile } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
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
  const number = url.searchParams.get("number");

  if (!repo || !number) {
    return NextResponse.json({ error: "repo and number are required" }, { status: 400 });
  }

  try {
    const stdout = await run("gh", [
      "pr",
      "view",
      number,
      "-R",
      repo,
      "--json",
      "title,body,author,number,additions,deletions,files,changedFiles,headRefName,baseRefName,state,isDraft,labels,reviewDecision,createdAt,updatedAt,url",
    ]);
    const pr = JSON.parse(stdout);
    return NextResponse.json(pr);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
