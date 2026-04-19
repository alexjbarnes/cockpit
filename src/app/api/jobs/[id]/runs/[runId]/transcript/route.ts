import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getRun } from "@/server/job-storage";
import { findSessionCwd, loadTranscript } from "@/server/transcript";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export function GET(req: NextRequest, { params }: { params: Promise<{ id: string; runId: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(async ({ id, runId }) => {
    const run = getRun(id, runId);
    if (!run) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    let cwd = run.cwd;
    if (!cwd) {
      const found = await findSessionCwd(run.sessionId);
      if (!found) {
        return NextResponse.json({ error: "Transcript not found" }, { status: 404 });
      }
      cwd = found;
    }

    const { messages } = await loadTranscript(run.sessionId, cwd);
    return NextResponse.json({ messages });
  });
}
