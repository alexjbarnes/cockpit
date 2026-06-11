import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { coercePluginScope, installPlugin } from "@/server/plugins";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { plugin?: string; scope?: string };
  if (!body.plugin) {
    return NextResponse.json({ error: "Missing plugin id" }, { status: 400 });
  }

  const scope = coercePluginScope(body.scope) ?? "user";
  const result = await installPlugin(body.plugin, scope);

  if (!result.ok) {
    return NextResponse.json({ error: result.stderr || "Install failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
