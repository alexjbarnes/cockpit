import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getCockpitDir } from "@/server/paths";
import { getSessionManager } from "@/server/singleton";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sessionId = await getSessionManager().getOrCreateCockpitAgentSession();
  return NextResponse.json({ sessionId, cwd: getCockpitDir() });
}
