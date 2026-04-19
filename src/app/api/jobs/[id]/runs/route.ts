import { NextRequest, NextResponse } from "next/server";
import { isAuthDisabled, validateSession } from "@/server/auth";
import { loadRuns } from "@/server/job-storage";

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(({ id }) => {
    const limitParam = req.nextUrl.searchParams.get("limit");
    let runs = loadRuns(id);
    runs.sort((a, b) => b.startedAt - a.startedAt);
    if (limitParam) {
      const limit = parseInt(limitParam, 10);
      if (limit > 0) runs = runs.slice(0, limit);
    }
    return NextResponse.json({ runs });
  });
}
