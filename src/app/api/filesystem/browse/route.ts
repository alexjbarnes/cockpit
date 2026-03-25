import { NextRequest, NextResponse } from "next/server";
import { readdir, stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { validateSession, isAuthDisabled } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token =
    req.cookies.get("cockpit_session")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
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

  const includeFiles = url.searchParams.get("includeFiles") === "true";

  const dirents = await readdir(resolved, { withFileTypes: true }).catch(() => []);
  const filtered = dirents
    .filter((d) => d.isDirectory() || (includeFiles && d.isFile()))
    .filter((d) => showHidden || !d.name.startsWith("."));

  const dirs = filtered
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = filtered
    .filter((d) => d.isFile())
    .sort((a, b) => a.name.localeCompare(b.name));

  const entries = [...dirs, ...files].map((d) => ({
    name: d.name,
    path: path.join(resolved, d.name),
    type: d.isDirectory() ? "directory" as const : "file" as const,
  }));

  return NextResponse.json({ path: resolved, entries });
}
