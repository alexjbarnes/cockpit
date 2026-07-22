import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { OPENROUTER_PROVIDER_ID, syncOpenRouterCatalog } from "@/server/provider-catalog";
import { OPENCODE_ZEN_PROVIDER_ID, syncZenModels } from "@/server/providers";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (id === OPENROUTER_PROVIDER_ID) {
    const result = await syncOpenRouterCatalog();
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
    return NextResponse.json({ ok: true, modelCount: result.modelCount, changes: result.changes });
  }
  if (id === OPENCODE_ZEN_PROVIDER_ID) {
    const result = await syncZenModels();
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
    return NextResponse.json({ ok: true, modelCount: result.modelCount });
  }
  return NextResponse.json({ error: "Provider has no synced catalog" }, { status: 400 });
}
