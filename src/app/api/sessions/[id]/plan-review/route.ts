import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { readPlanRecord } from "@/server/plan-review-storage";
import { getSessionManager } from "@/server/singleton";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/** A session's plan: every version it has proposed, the markup in progress,
 *  and which version, if any, is waiting for an answer right now. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const record = readPlanRecord({ kind: "session", id });
  const pending = getSessionManager()
    .getPendingRequests(id)
    .find((r) => r.toolName === "ExitPlanMode");
  return NextResponse.json({
    versions: record.versions,
    draft: record.draft ?? null,
    pending: pending ? { requestId: pending.requestId, version: pending.planVersion ?? null } : null,
  });
}
