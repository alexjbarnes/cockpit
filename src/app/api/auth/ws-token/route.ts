import { NextRequest, NextResponse } from "next/server";
import { isAuthDisabled, validateSession } from "@/server/auth";

export function GET(req: NextRequest) {
  if (isAuthDisabled()) {
    return NextResponse.json({ token: "disabled" });
  }

  const token = req.cookies.get("cockpit_session")?.value;
  if (!token || !validateSession(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({ token });
}
