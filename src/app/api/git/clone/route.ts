import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { isAuthDisabled, validateSession } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

function runGitClone(url: string, dest: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["clone", "--progress", url, dest], {
      env: { ...process.env },
    });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(dest);
      } else {
        reject(new Error(stderr.trim() || `git clone exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body?.url || !body?.parentPath) {
    return NextResponse.json({ error: "url and parentPath are required" }, { status: 400 });
  }

  const url: string = body.url.trim();
  const parentPath: string = body.parentPath.trim();
  const folderName: string | undefined = body.folderName?.trim();

  const parentStat = await stat(parentPath).catch(() => null);
  if (!parentStat?.isDirectory()) {
    return NextResponse.json({ error: "Parent directory does not exist" }, { status: 400 });
  }

  // Derive repo name from URL if no folder name given
  let repoName = folderName;
  if (!repoName) {
    const urlPath = url.replace(/\.git$/, "").replace(/\/$/, "");
    repoName = path.basename(urlPath) || "repo";
  }

  const dest = path.join(parentPath, repoName);

  const destStat = await stat(dest).catch(() => null);
  if (destStat) {
    return NextResponse.json({ error: `${repoName} already exists in that directory` }, { status: 409 });
  }

  try {
    await runGitClone(url, dest);
    return NextResponse.json({ path: dest });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
