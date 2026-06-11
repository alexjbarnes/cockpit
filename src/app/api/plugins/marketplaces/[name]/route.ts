import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { coercePluginScope, removeMarketplace, updateMarketplace } from "@/server/plugins";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await params;
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "update") {
    return NextResponse.json({ error: `Unknown action: ${body.action ?? "(none)"}` }, { status: 400 });
  }

  const result = await updateMarketplace(name);
  if (!result.ok) {
    return NextResponse.json({ error: result.stderr || "Update failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await params;
  const scope = coercePluginScope(new URL(req.url).searchParams.get("scope"));
  const result = await removeMarketplace(name, scope);

  if (!result.ok) {
    return NextResponse.json({ error: result.stderr || "Remove failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
