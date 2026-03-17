import { NextRequest, NextResponse } from "next/server";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { validateToken } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token =
    req.cookies.get("aperture_token")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateToken(token);
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body?.parentPath || !body?.name) {
    return NextResponse.json({ error: "parentPath and name are required" }, { status: 400 });
  }

  const name = body.name.trim();
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    return NextResponse.json({ error: "Invalid folder name" }, { status: 400 });
  }

  const fullPath = path.join(body.parentPath, name);

  const existing = await stat(fullPath).catch(() => null);
  if (existing) {
    return NextResponse.json({ error: "A file or folder with that name already exists" }, { status: 409 });
  }

  try {
    await mkdir(fullPath);
    return NextResponse.json({ path: fullPath });
  } catch (err) {
    return NextResponse.json({ error: `Failed to create folder: ${(err as Error).message}` }, { status: 500 });
  }
}
