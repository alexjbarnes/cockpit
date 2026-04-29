import { NextRequest, NextResponse } from "next/server";
import { needsSetup, validateSession } from "@/server/auth";

export function GET(req: NextRequest) {
  if (needsSetup()) {
    return NextResponse.json({ authenticated: false, needsSetup: true }, { status: 401 });
  }

  const token = req.cookies.get("cockpit_session")?.value;
  if (!token || !validateSession(token)) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  return NextResponse.json({ authenticated: true });
}
