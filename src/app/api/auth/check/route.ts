import { NextRequest, NextResponse } from "next/server";
import { needsSetup, validateSession } from "@/server/auth";

export function GET(req: NextRequest) {
  const t0 = performance.now();
  if (needsSetup()) {
    console.log(`[api/auth/check] needsSetup=true in ${(performance.now() - t0).toFixed(0)}ms`);
    return NextResponse.json({ authenticated: false, needsSetup: true }, { status: 401 });
  }

  const token = req.cookies.get("cockpit_session")?.value;
  if (!token || !validateSession(token)) {
    console.log(`[api/auth/check] unauthorized in ${(performance.now() - t0).toFixed(0)}ms`);
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  console.log(`[api/auth/check] authenticated in ${(performance.now() - t0).toFixed(0)}ms`);
  return NextResponse.json({ authenticated: true });
}
