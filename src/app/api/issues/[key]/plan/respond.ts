import { type NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { IssuePlanError } from "@/server/issue-plan";

export function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/** Run a plan operation and answer with its result, or with the status its
 *  refusal names. Anything else that goes wrong is a bad request: these
 *  routes only ever fail on what they were sent. */
export function answer(run: () => unknown, status = 200): NextResponse {
  try {
    return NextResponse.json(run(), { status });
  } catch (err) {
    if (err instanceof IssuePlanError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not update the plan" }, { status: 400 });
  }
}
