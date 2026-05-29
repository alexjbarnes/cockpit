import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { deleteInboxMessage, markRead } from "@/server/inbox";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  let read = true;
  try {
    const body = await req.json();
    if (typeof body.read === "boolean") read = body.read;
  } catch {}
  const found = markRead(id, read);
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(({ id }) => {
    const found = deleteInboxMessage(id);
    if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
