import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";

export function GET(req: NextRequest) {
  const token = req.cookies.get("cockpit_session")?.value;
  if (!token || !validateSession(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({ token });
}
