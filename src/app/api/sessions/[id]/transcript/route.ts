import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getSessionPrefs } from "@/server/session-prefs";
import { findSessionCwd, loadTranscript } from "@/server/transcript";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/** A session's own conversation, for a peek at what it is doing: the last
 *  messages of its transcript, as the chat would draw them. */
export function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(async ({ id }) => {
    let cwd = req.nextUrl.searchParams.get("cwd") || "";
    const prefs = getSessionPrefs(id);
    const cliSessionId = prefs?.cliSessionId || id;
    if (!cwd) {
      const found = await findSessionCwd(cliSessionId);
      if (!found) {
        return NextResponse.json({ error: "Could not determine cwd" }, { status: 400 });
      }
      cwd = found;
    }
    const { messages } = await loadTranscript(cliSessionId, cwd, { tailLines: 200 });
    return NextResponse.json({ messages });
  });
}
