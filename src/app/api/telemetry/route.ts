import { type NextRequest, NextResponse } from "next/server";
import { parseTelemetryQuery } from "@/lib/telemetry-query";
import { validateSession } from "@/server/auth";
import { getTelemetry } from "@/server/singleton";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/** Stored telemetry records, filtered and paged. See TelemetryQuery. */
export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const telemetry = getTelemetry();
  if (!telemetry) {
    return NextResponse.json({ error: "Telemetry not available" }, { status: 503 });
  }
  const parsed = parseTelemetryQuery(req.nextUrl.searchParams);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  try {
    return NextResponse.json(await telemetry.query(parsed.query));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
