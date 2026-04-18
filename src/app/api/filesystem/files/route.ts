import { execFile } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { isAuthDisabled, validateSession } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const query = (url.searchParams.get("query") || "").toLowerCase();

  const files = await new Promise<string[]>((resolve) => {
    execFile("git", ["ls-files"], { cwd, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      const lines = stdout.split("\n").filter(Boolean);
      if (!query) {
        resolve(lines.slice(0, 20));
        return;
      }
      const matched: string[] = [];
      for (const line of lines) {
        if (line.toLowerCase().includes(query)) {
          matched.push(line);
          if (matched.length >= 20) break;
        }
      }
      resolve(matched);
    });
  });

  return NextResponse.json({ files });
}
