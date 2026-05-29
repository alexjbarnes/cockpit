import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { deleteProvider, getProvider, updateProvider } from "@/server/providers";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const existing = getProvider(id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const body = await req.json();
    const updated = updateProvider(id, body);
    return NextResponse.json(updated);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Update failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkAuth(_req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    deleteProvider(id);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Delete failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
