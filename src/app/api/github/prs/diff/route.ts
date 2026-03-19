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
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      if (err && !(err as NodeJS.ErrnoException).code && stdout) {
        resolve(stdout);
      } else if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function splitDiff(raw: string): { path: string; patch: string }[] {
  const lines = raw.split("\n");
  const files: { path: string; lines: string[] }[] = [];
  let current: { path: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      // Handle renames: diff --git a/old b/new - take b/ path
      const match = line.match(/diff --git a\/.+ b\/(.+)/);
      current = { path: match?.[1] || "unknown", lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) files.push(current);

  return files.map((f) => ({ path: f.path, patch: f.lines.join("\n") }));
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const repo = url.searchParams.get("repo");
  const number = url.searchParams.get("number");

  if (!repo || !number) {
    return NextResponse.json(
      { error: "repo and number are required" },
      { status: 400 },
    );
  }

  try {
    const stdout = await run("gh", [
      "pr",
      "diff",
      number,
      "-R",
      repo,
      "--color",
      "never",
    ]);
    const files = splitDiff(stdout);
    return NextResponse.json({ files });
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 },
    );
  }
}
