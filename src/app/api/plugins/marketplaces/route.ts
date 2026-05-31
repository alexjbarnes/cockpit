import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { addMarketplace, coercePluginScope, updateMarketplace } from "@/server/plugins";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { action?: string; source?: string; scope?: string };

  if (body.action === "update") {
    const result = await updateMarketplace();
    if (!result.ok) {
      return NextResponse.json({ error: result.stderr || "Update failed" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "add") {
    const source = body.source?.trim();
    if (!source) {
      return NextResponse.json({ error: "Missing marketplace source" }, { status: 400 });
    }
    const result = await addMarketplace(source, coercePluginScope(body.scope));
    if (!result.ok) {
      return NextResponse.json({ error: result.stderr || "Add failed" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: `Unknown action: ${body.action ?? "(none)"}` }, { status: 400 });
}
