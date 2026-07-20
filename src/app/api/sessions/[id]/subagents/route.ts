import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getSessionPrefs } from "@/server/session-prefs";
import { listSubagentMetasForSessions, loadSubagentByToolUse } from "@/server/subagent-transcript";
import { findSessionCwd } from "@/server/transcript";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(async ({ id }) => {
    let cwd = req.nextUrl.searchParams.get("cwd") || "";
    const prefs = getSessionPrefs(id);
    if (!cwd) {
      const sessionId = prefs?.cliSessionId || id;
      const found = await findSessionCwd(sessionId);
      if (!found) {
        return NextResponse.json({ error: "Could not determine cwd" }, { status: 400 });
      }
      cwd = found;
    }

    const cliSessionIds: string[] = [...(prefs?.previousCliSessionIds || []), ...(prefs?.cliSessionId ? [prefs.cliSessionId] : [id])];

    const toolUseId = req.nextUrl.searchParams.get("toolUseId") || "";
    if (!toolUseId) {
      const metas = await listSubagentMetasForSessions(cliSessionIds, cwd);
      return NextResponse.json({
        subagents: metas.map((m) => ({ toolUseId: m.toolUseId, agentType: m.agentType, description: m.description })),
      });
    }

    const messages = await loadSubagentByToolUse(cliSessionIds, cwd, toolUseId);
    if (messages === null) {
      return NextResponse.json({ error: "No subagent transcript for that tool use" }, { status: 404 });
    }
    return NextResponse.json({ messages });
  });
}
