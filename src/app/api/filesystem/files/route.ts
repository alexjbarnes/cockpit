import { execFile } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

const LIMIT = 50;

const EXCLUDED_DIRS = ["node_modules", ".git", ".next", "dist", "__pycache__", ".venv", "vendor", ".cache", "build", "coverage"];

function listFiles(cwd: string): Promise<string[]> {
  const excludes = EXCLUDED_DIRS.flatMap((d) => ["-not", "-path", `*/${d}/*`]);
  return new Promise((resolve) => {
    execFile("find", [".", "-maxdepth", "5", "-type", "f", ...excludes], { cwd, maxBuffer: 2 * 1024 * 1024, timeout: 3000 }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      resolve(
        stdout
          .split("\n")
          .filter(Boolean)
          .map((p) => p.replace(/^\.\//, "")),
      );
    });
  });
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const query = (url.searchParams.get("query") || "").toLowerCase();

  const lines = await listFiles(cwd);

  if (!query) {
    return NextResponse.json({ files: lines.slice(0, LIMIT) });
  }

  const matched: string[] = [];
  for (const line of lines) {
    if (line.toLowerCase().includes(query)) {
      matched.push(line);
      if (matched.length >= LIMIT) break;
    }
  }
  return NextResponse.json({ files: matched });
}
