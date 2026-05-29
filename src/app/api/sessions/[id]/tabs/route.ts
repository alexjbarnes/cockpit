import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getSessionPrefs, setSessionPrefs } from "@/server/session-prefs";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const prefs = getSessionPrefs(id);
  return NextResponse.json({
    openTabs: prefs?.openTabs || [],
    activeTabId: prefs?.activeTabId || "chat",
  });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await req.json();
  setSessionPrefs(id, {
    openTabs: body.openTabs || [],
    activeTabId: body.activeTabId || "chat",
  });
  return NextResponse.json({ ok: true });
}
