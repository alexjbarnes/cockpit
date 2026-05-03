import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getNotificationSettings } from "@/server/notification-settings";
import { sendTestNotification } from "@/server/notifications";
import type { NotificationProviderEntry } from "@/types";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = (await req.json()) as { provider: NotificationProviderEntry };
    if (!body.provider) {
      return NextResponse.json({ error: "Missing provider" }, { status: 400 });
    }
    const settings = getNotificationSettings();
    const result = await sendTestNotification(body.provider, settings.baseUrl);
    if (result === "ok") {
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ success: false, error: result }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "Internal error" }, { status: 500 });
  }
}
