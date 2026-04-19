import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { loadRuns } from "@/server/job-storage";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(({ id }) => {
    const limitParam = req.nextUrl.searchParams.get("limit");
    const offsetParam = req.nextUrl.searchParams.get("offset");
    const runs = loadRuns(id);
    runs.sort((a, b) => b.startedAt - a.startedAt);
    const total = runs.length;
    const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10)) : 0;
    const limit = limitParam ? Math.max(1, parseInt(limitParam, 10)) : total;
    const page = runs.slice(offset, offset + limit);
    return NextResponse.json({ runs: page, total, hasMore: offset + limit < total });
  });
}
