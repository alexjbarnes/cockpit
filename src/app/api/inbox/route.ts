import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { clearInbox, deleteInboxMessages, getInboxMessages, getUnreadCount, markAllRead, markManyRead } from "@/server/inbox";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const countOnly = req.nextUrl.searchParams.get("count");
  if (countOnly === "true") {
    return NextResponse.json({ unread: getUnreadCount() });
  }

  return NextResponse.json({ messages: getInboxMessages() });
}

export function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return req.json().then((body) => {
    const action = body.action;
    if (action === "mark_all_read") {
      markAllRead(body.read !== false);
      return NextResponse.json({ ok: true });
    }
    if (action === "clear") {
      clearInbox();
      return NextResponse.json({ ok: true });
    }
    // Bulk actions on the messages selected in the inbox, in one write.
    if (action === "delete" || action === "mark_read") {
      const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((id: unknown): id is string => typeof id === "string") : [];
      if (ids.length === 0) {
        return NextResponse.json({ error: "ids must be a non-empty array of message ids" }, { status: 400 });
      }
      const count = action === "delete" ? deleteInboxMessages(ids) : markManyRead(ids, body.read !== false);
      return NextResponse.json({ ok: true, count });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  });
}
