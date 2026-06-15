import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { logDiag } from "@/server/debug-logger";
import { getSessionPrefs, setSessionPrefs } from "@/server/session-prefs";

function countTerminals(tabs: Array<{ type?: string }> | undefined): number {
  return (tabs || []).filter((t) => t.type === "terminal").length;
}

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
  const openTabs = prefs?.openTabs || [];
  logDiag(id, "tabs:restore", { count: openTabs.length, terminals: countTerminals(openTabs), activeTabId: prefs?.activeTabId || "chat" });
  return NextResponse.json({
    openTabs,
    activeTabId: prefs?.activeTabId || "chat",
  });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await req.json();
  const openTabs = body.openTabs || [];
  logDiag(id, "tabs:persist", { count: openTabs.length, terminals: countTerminals(openTabs), activeTabId: body.activeTabId || "chat" });
  setSessionPrefs(id, {
    openTabs,
    activeTabId: body.activeTabId || "chat",
  });
  return NextResponse.json({ ok: true });
}
