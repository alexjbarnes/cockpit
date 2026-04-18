import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { isAuthDisabled, validateSession } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

const PINNED_FILE = path.join(homedir(), ".claude", "cockpit", "pinned_sessions.json");

async function readPinned(): Promise<string[]> {
  try {
    const raw = await readFile(PINNED_FILE, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writePinned(ids: string[]): Promise<void> {
  await mkdir(path.dirname(PINNED_FILE), { recursive: true });
  await writeFile(PINNED_FILE, JSON.stringify(ids, null, 2) + "\n");
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
  if (!body || !Array.isArray(body.pinned)) {
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
  const { add, remove } = body as { add?: string; remove?: string };
  const pinned = new Set(await readPinned());
  if (add) pinned.add(add);
  if (remove) pinned.delete(remove);
  const list = [...pinned];
  await writePinned(list);
  return NextResponse.json({ pinned: list });
}
