import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getSessionPrefs } from "@/server/session-prefs";
import { findSessionCwd, sumTranscriptUsage, type TokenTotals } from "@/server/transcript";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/**
 * Cumulative token spend for a session, read from the transcript on demand.
 *
 * On demand rather than pushed: it needs a full-file scan, and the only thing
 * that reads it is a panel the user opens. The CLI-session chain is summed the
 * way search and context routes walk it, so a session that has been /clear-ed
 * still reports what the whole thing cost rather than only the latest leg.
 */
export function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(async ({ id }) => {
    const prefs = getSessionPrefs(id);

    let cwd = req.nextUrl.searchParams.get("cwd") || "";
    if (!cwd) {
      const found = await findSessionCwd(prefs?.cliSessionId || id);
      if (!found) {
        return NextResponse.json({ error: "Could not determine cwd" }, { status: 400 });
      }
      cwd = found;
    }

    const cliSessionIds = [...(prefs?.previousCliSessionIds || []), ...(prefs?.cliSessionId ? [prefs.cliSessionId] : [id])];
    const parts = await Promise.all(cliSessionIds.map((sid) => sumTranscriptUsage(sid, cwd)));

    const totals = parts.reduce<TokenTotals>(
      (acc, p) => ({
        input: acc.input + p.input,
        output: acc.output + p.output,
        cacheRead: acc.cacheRead + p.cacheRead,
        cacheCreate: acc.cacheCreate + p.cacheCreate,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    );

    return NextResponse.json(totals);
  });
}
