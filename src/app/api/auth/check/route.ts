import { NextRequest, NextResponse } from "next/server";
import { needsSetup, validateSession } from "@/server/auth";
import { debugLog } from "@/server/debug-logger";

export function GET(req: NextRequest) {
  const t0 = performance.now();
  if (needsSetup()) {
    debugLog(`[api/auth/check] needsSetup=true in ${(performance.now() - t0).toFixed(0)}ms`);
    return NextResponse.json({ authenticated: false, needsSetup: true }, { status: 401 });
  }

  const token = req.cookies.get("cockpit_session")?.value;
  if (!token || !validateSession(token)) {
    debugLog(`[api/auth/check] unauthorized in ${(performance.now() - t0).toFixed(0)}ms`);
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  debugLog(`[api/auth/check] authenticated in ${(performance.now() - t0).toFixed(0)}ms`);
  return NextResponse.json({ authenticated: true });
}
