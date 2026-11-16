import { type NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getWorkflowEngine } from "@/server/singleton";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/** Act on an agent's work on an issue: `{ action: "retry" }` lets an issue
 *  that is held, or left where an agent works with nothing working on it, be
 *  worked again, and `{ action: "stop" }` stops the run working on it. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const engine = getWorkflowEngine();
  if (!engine) return NextResponse.json({ error: "The workflow engine is not running" }, { status: 503 });
  const { key } = await params;
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  try {
    if (body?.action === "retry") return NextResponse.json({ issue: engine.retry(key) });
    if (body?.action === "stop") return NextResponse.json({ run: engine.stopRun(key) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not do that" }, { status: 409 });
  }
  return NextResponse.json({ error: 'action must be "retry" or "stop"' }, { status: 400 });
}
