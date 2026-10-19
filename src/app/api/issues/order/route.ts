import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { placeIssue } from "@/server/issue-storage";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/**
 * Where a dragged issue belongs: `{ key, status, beforeKey?, afterKey? }`. The
 * neighbours are the rows the user saw around the drop, which is why the
 * request names them rather than sending a list of ids — a filtered view does
 * not know the issues it cannot see, and must not renumber them.
 */
export async function PUT(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const key = typeof body?.key === "string" ? body.key : null;
  const status = typeof body?.status === "string" ? body.status : null;
  if (!key || !status) {
    return NextResponse.json({ error: "key and status are required" }, { status: 400 });
  }
  for (const field of ["beforeKey", "afterKey"] as const) {
    if (body?.[field] !== undefined && typeof body[field] !== "string") {
      return NextResponse.json({ error: `${field} must be a string` }, { status: 400 });
    }
  }

  try {
    const issues = placeIssue(key, status, body.beforeKey, body.afterKey);
    return NextResponse.json({ issues });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // An unknown key, or a status that project does not have: the caller's
    // fault, not a crash.
    const bad = message.startsWith("Unknown issue") || message.startsWith("status must be one of");
    return NextResponse.json({ error: message }, { status: bad ? 400 : 500 });
  }
}
