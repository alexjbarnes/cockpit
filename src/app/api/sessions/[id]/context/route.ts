import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getSessionPrefs } from "@/server/session-prefs";
import { findSessionCwd, loadTranscript } from "@/server/transcript";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

const CONTEXT_RADIUS = 10;

export function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(async ({ id }) => {
    const ts = req.nextUrl.searchParams.get("timestamp") || "";
    if (!ts) {
      return NextResponse.json({ error: "timestamp is required" }, { status: 400 });
    }
    const timestamp = Number(ts);

    let cwd = req.nextUrl.searchParams.get("cwd") || "";
    if (!cwd) {
      const prefs = getSessionPrefs(id);
      const sessionId = prefs?.cliSessionId || id;
      const found = await findSessionCwd(sessionId);
      if (!found) {
        return NextResponse.json({ error: "Could not determine cwd" }, { status: 400 });
      }
      cwd = found;
    }

    const prefs = getSessionPrefs(id);
    const cliSessionIds: string[] = [...(prefs?.previousCliSessionIds || []), ...(prefs?.cliSessionId ? [prefs.cliSessionId] : [id])];

    const transcripts = await Promise.all(cliSessionIds.map((sid) => loadTranscript(sid, cwd)));

    const allMessages = transcripts.flatMap((t) => t.messages);

    // Find by closest timestamp since message IDs are not stable across loads
    let targetIndex = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < allMessages.length; i++) {
      const delta = Math.abs(allMessages[i].timestamp - timestamp);
      if (delta < bestDelta) {
        bestDelta = delta;
        targetIndex = i;
      }
    }

    if (targetIndex === -1) {
      return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }

    const start = Math.max(0, targetIndex - CONTEXT_RADIUS);
    const end = Math.min(allMessages.length, targetIndex + CONTEXT_RADIUS + 1);
    const messages = allMessages.slice(start, end);
    const targetMessageId = allMessages[targetIndex].id;

    return NextResponse.json({
      messages,
      targetMessageId,
      hasMoreBefore: start > 0,
      hasMoreAfter: end < allMessages.length,
    });
  });
}
