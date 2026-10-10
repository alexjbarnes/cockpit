import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getSessionManager } from "@/server/singleton";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/**
 * Answer a permission request without the app being open: this is what a web
 * push notification's Approve and Deny buttons call. Same-origin from the
 * service worker, so the session cookie rides along like everywhere else.
 *
 * Only permissions. A question needs answers typed into it, and the plan card
 * needs a message, so neither is answerable from a lock screen — the
 * notification only offers to open the session for those.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; requestId: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, requestId } = await params;
  const body = await req.json().catch(() => null);
  // Strictly a boolean: {"allowed": "false"} is truthy, and approving a
  // command the user just denied is the one failure this route must not have.
  if (typeof body?.allowed !== "boolean") {
    return NextResponse.json({ error: "allowed must be a boolean" }, { status: 400 });
  }

  const manager = getSessionManager();
  const pending = manager.getPendingRequest(id, requestId);
  if (!pending) {
    return NextResponse.json({ error: "That request is no longer waiting" }, { status: 404 });
  }
  if (pending.type === "question") {
    return NextResponse.json({ error: "A question has to be answered in the session" }, { status: 400 });
  }

  const answered = manager.respondToPermission(id, requestId, body.allowed);
  if (!answered) {
    return NextResponse.json({ error: "The session is not running" }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
