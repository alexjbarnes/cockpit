import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getNotificationSettings, setNotificationSettings } from "@/server/notification-settings";
import type { NotificationSettings } from "@/types";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(getNotificationSettings());
}

export async function PUT(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await req.json()) as NotificationSettings;
  const updated = setNotificationSettings(body);
  return NextResponse.json(updated);
}
