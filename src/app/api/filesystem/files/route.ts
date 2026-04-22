import { execFile } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

const LIMIT = 50;

function gitFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        resolve(stdout.split("\n").filter(Boolean));
      },
    );
  });
}

function findFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "find",
      [".", "-maxdepth", "4", "-type", "f", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"],
      { cwd, maxBuffer: 2 * 1024 * 1024, timeout: 3000 },
      (err, stdout) => {
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
      },
    );
  });
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const query = (url.searchParams.get("query") || "").toLowerCase();

  let lines = await gitFiles(cwd);
  if (lines.length === 0) {
    lines = await findFiles(cwd);
  }

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
