import { type NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getWorkflowEngine } from "@/server/singleton";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/** What the workflows are doing now: runs going, issues waiting for a slot,
 *  issues held for a person, and how many slots are in use. */
export function GET(req: NextRequest) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const engine = getWorkflowEngine();
  if (!engine) return NextResponse.json({ error: "The workflow engine is not running" }, { status: 503 });
  return NextResponse.json(engine.activity());
}
