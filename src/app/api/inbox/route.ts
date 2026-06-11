import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { clearInbox, getInboxMessages, getUnreadCount, markAllRead } from "@/server/inbox";

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
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  });
}
