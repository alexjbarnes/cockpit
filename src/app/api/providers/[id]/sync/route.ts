import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { OPENROUTER_PROVIDER_ID, syncOpenRouterCatalog } from "@/server/provider-catalog";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (id !== OPENROUTER_PROVIDER_ID) {
    return NextResponse.json({ error: "Provider has no synced catalog" }, { status: 400 });
  }
  const result = await syncOpenRouterCatalog();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json({ ok: true, modelCount: result.modelCount, changes: result.changes });
}
