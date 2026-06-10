import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getJobScheduler } from "@/server/singleton";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(({ id }) => {
    const scheduler = getJobScheduler();
    if (!scheduler) {
      return NextResponse.json({ error: "Scheduler not available" }, { status: 503 });
    }

    try {
      const run = scheduler.stopJob(id);
      return NextResponse.json({ run });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 404 });
    }
  });
}
