import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { readPinned, writePinned } from "@/server/pinned-storage";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pinned = await readPinned("pinned_reviews.json");
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
  await writePinned("pinned_reviews.json", body.pinned);
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
  const list = await readPinned("pinned_reviews.json");
  if (add && !list.includes(add)) {
    list.push(add);
  }
  if (remove) {
    const i = list.indexOf(remove);
    if (i >= 0) list.splice(i, 1);
  }
  await writePinned("pinned_reviews.json", list);
  return NextResponse.json({ pinned: list });
}
