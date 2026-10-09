import { NextRequest, NextResponse } from "next/server";
import { getAssistantSettings } from "@/server/assistant-settings";
import { validateSession } from "@/server/auth";
import { getSessionManager } from "@/server/singleton";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/**
 * The assistant's session id and live state, for the sidebar's status dot.
 *
 * Read-only on purpose: /api/assistant-session creates the session, so asking
 * that one on every page load would materialise a session for someone who has
 * never opened the assistant. No stored id means it has never been opened.
 */
export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sessionId = getAssistantSettings().sessionId;
  if (!sessionId) {
    return NextResponse.json({ sessionId: null, status: "idle", pendingRequestCount: 0 });
  }

  const info = getSessionManager()
    .listKnownSessions()
    .find((s) => s.id === sessionId);
  return NextResponse.json({
    sessionId,
    status: info?.status ?? "idle",
    pendingRequestCount: info?.pendingRequestCount ?? 0,
  });
}
