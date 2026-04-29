import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getRun } from "@/server/job-storage";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export function GET(req: NextRequest, { params }: { params: Promise<{ id: string; runId: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(({ id, runId }) => {
    const run = getRun(id, runId);
    if (!run) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ run });
  });
}
