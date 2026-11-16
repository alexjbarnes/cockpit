import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getDefaults, setDefaults } from "@/server/defaults";
import { getWorkflowEngine } from "@/server/singleton";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(getDefaults());
}

export async function PATCH(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json();
  const updated = setDefaults(body);
  // Workflows switched on, unpaused or given more room: issues may be waiting.
  if (body && ("workflowsEnabled" in body || "workflowsPaused" in body || "workflowMaxParallel" in body || "issuesEnabled" in body)) {
    getWorkflowEngine()?.kick();
  }
  return NextResponse.json(updated);
}
