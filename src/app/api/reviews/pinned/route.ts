import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getClaudeDir } from "@/server/paths";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

function pinnedFile(): string {
  return path.join(getClaudeDir(), "cockpit", "pinned_reviews.json");
}

async function readPinned(): Promise<string[]> {
  try {
    const raw = await readFile(pinnedFile(), "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writePinned(ids: string[]): Promise<void> {
  const fp = pinnedFile();
  await mkdir(path.dirname(fp), { recursive: true });
  await writeFile(fp, JSON.stringify(ids, null, 2) + "\n");
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pinned = await readPinned();
  return NextResponse.json({ pinned });
}

export async function PUT(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json();
  if (!body || !Array.isArray(body.pinned) || !body.pinned.every((id: unknown) => typeof id === "string")) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  await writePinned(body.pinned);
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json();
  const { add, remove } = body as { add?: unknown; remove?: unknown };
  if (add !== undefined && typeof add !== "string") {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (remove !== undefined && typeof remove !== "string") {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const list = await readPinned();
  if (add && !list.includes(add)) {
    list.push(add);
  }
  if (remove) {
    const i = list.indexOf(remove);
    if (i >= 0) list.splice(i, 1);
  }
  await writePinned(list);
  return NextResponse.json({ pinned: list });
}
