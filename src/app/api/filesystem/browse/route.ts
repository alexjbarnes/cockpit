import { NextRequest, NextResponse } from "next/server";
import { readdir, stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { validateToken } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token =
    req.cookies.get("aperture_token")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateToken(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path") || homedir();
  const showHidden = url.searchParams.get("showHidden") === "true";

  const resolved = await realpath(path.resolve(rawPath)).catch(() => null);
  if (!resolved) {
    return NextResponse.json({ error: "Path does not exist" }, { status: 400 });
  }

  const info = await stat(resolved).catch(() => null);
  if (!info || !info.isDirectory()) {
    return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
  }

  const dirents = await readdir(resolved, { withFileTypes: true }).catch(() => []);
  const entries = dirents
    .filter((d) => d.isDirectory())
    .filter((d) => showHidden || !d.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({
      name: d.name,
      path: path.join(resolved, d.name),
    }));

  return NextResponse.json({ path: resolved, entries });
}
