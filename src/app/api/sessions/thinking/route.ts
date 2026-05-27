import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getSessionManager } from "@/server/singleton";
import { checkNonAnthropicThinking, findTranscriptFile, getTranscriptPath, stripNonAnthropicThinking } from "@/server/transcript";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

function resolveTranscriptPath(sessionId: string): string | null {
  const manager = getSessionManager();
  const cwd = manager.getSessionCwd(sessionId);
  if (!cwd) return null;
  const cliId = manager.getCliSessionId(sessionId) || sessionId;
  return getTranscriptPath(cliId, cwd);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const filePath = resolveTranscriptPath(sessionId) || (await findTranscriptFile(sessionId));
  if (!filePath) {
    return NextResponse.json({ hasNonAnthropicThinking: false, count: 0, models: [] });
  }

  const result = await checkNonAnthropicThinking(filePath);
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const sessionId = body.sessionId as string;
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const filePath = resolveTranscriptPath(sessionId) || (await findTranscriptFile(sessionId));
  if (!filePath) {
    return NextResponse.json({ error: "Transcript not found" }, { status: 404 });
  }

  const stripped = await stripNonAnthropicThinking(filePath);
  return NextResponse.json({ stripped });
}
