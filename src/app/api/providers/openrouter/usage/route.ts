import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getOpenRouterUsage } from "@/server/provider-catalog";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const usage = await getOpenRouterUsage();
    if (!usage) return NextResponse.json({ error: "OpenRouter is not connected" }, { status: 404 });
    return NextResponse.json(usage);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
