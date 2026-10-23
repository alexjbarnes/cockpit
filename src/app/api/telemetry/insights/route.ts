import { type NextRequest, NextResponse } from "next/server";
import { parseInsightsQuery } from "@/lib/insights/query";
import { validateSession } from "@/server/auth";
import { getInsights } from "@/server/insights";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/** One Insights view: the telemetry for a range, priced and labelled. See InsightsQuery. */
export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = parseInsightsQuery(req.nextUrl.searchParams, Date.now());
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  try {
    const payload = await getInsights(parsed.query);
    if (!payload) return NextResponse.json({ error: "Telemetry not available" }, { status: 503 });
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
