import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { validateToken } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token =
    req.cookies.get("aperture_token")?.value ||
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

export interface GitFileChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface GitStatusResponse {
  branch: string;
  files: GitFileChange[];
  ahead: number;
}

function parseStatusCode(xy: string): string {
  const x = xy[0];
  const y = xy[1];
  if (x === "?" && y === "?") return "untracked";
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  if (x === "R" || y === "R") return "renamed";
  if (x === "M" || y === "M") return "modified";
  return "modified";
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }

  try {
    const branchOut = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    const branch = branchOut.trim();

    // Count unpushed commits
    let ahead = 0;
    try {
      const aheadOut = await run("git", ["rev-list", "--count", "@{u}..HEAD"], cwd);
      ahead = parseInt(aheadOut.trim(), 10) || 0;
    } catch {
      // No upstream configured or no remote
    }

    // Get list of changed files (staged + unstaged + untracked)
    const statusOut = await run("git", ["status", "--porcelain", "-uall"], cwd);

    const filePaths: { path: string; status: string }[] = [];
    for (const line of statusOut.split("\n")) {
      if (!line) continue;
      const xy = line.slice(0, 2);
      const filePath = line.slice(3).split(" -> ").pop()!.trim();
      filePaths.push({ path: filePath, status: parseStatusCode(xy) });
    }

    // Get diff stats for tracked files
    let diffStats = "";
    try {
      diffStats = await run("git", ["diff", "--numstat", "HEAD"], cwd);
    } catch {
      // Might fail on initial commit with no HEAD
      try {
        diffStats = await run("git", ["diff", "--numstat", "--cached"], cwd);
      } catch {
        // No commits yet
      }
    }

    const statsMap = new Map<string, { additions: number; deletions: number }>();
    for (const line of diffStats.split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const adds = parts[0] === "-" ? 0 : parseInt(parts[0], 10);
      const dels = parts[1] === "-" ? 0 : parseInt(parts[1], 10);
      const file = parts[2].split(" -> ").pop()!.trim();
      statsMap.set(file, { additions: adds, deletions: dels });
    }

    const files: GitFileChange[] = filePaths.map((f) => ({
      path: f.path,
      status: f.status,
      additions: statsMap.get(f.path)?.additions ?? 0,
      deletions: statsMap.get(f.path)?.deletions ?? 0,
    }));

    return NextResponse.json({ branch, files, ahead } satisfies GitStatusResponse);
  } catch {
    return NextResponse.json({ error: "Not a git repository" }, { status: 400 });
  }
}
