import { type NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getTelemetry } from "@/server/singleton";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/** Whether telemetry can be stored, what has arrived, and what was dropped.
 *  `?session=<id>` adds that session's records by name. */
export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const telemetry = getTelemetry();
  if (!telemetry) {
    return NextResponse.json({ error: "Telemetry not available" }, { status: 503 });
  }
  try {
    return NextResponse.json(await telemetry.stats(req.nextUrl.searchParams.get("session") || undefined));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
