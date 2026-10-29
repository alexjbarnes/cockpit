import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { debugLog } from "@/server/debug-logger";
import { getSessionPrefs } from "@/server/session-prefs";
import { getSessionManager } from "@/server/singleton";
import { scanSessionsByIds } from "@/server/transcript";
import type { SessionInfo } from "@/types";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  const t0 = performance.now();
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const idsParam = req.nextUrl.searchParams.get("ids") || "";
  const requested = idsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    return NextResponse.json({ sessions: [] });
  }

  // A pinned id is not always a transcript's name. A session that ran /clear
  // keeps its cockpit id while the conversation moves to a new CLI id, and an
  // older CLI id is no filename either, so the pin is resolved through the
  // prefs chain and answered under the id the caller asked for.
  const prefsById = new Map(requested.map((id) => [id, getSessionPrefs(id)]));
  const candidates = new Set<string>();
  for (const id of requested) {
    candidates.add(id);
    const prefs = prefsById.get(id);
    for (const c of [prefs?.cliSessionId, ...(prefs?.previousCliSessionIds ?? [])]) {
      if (c) candidates.add(c);
    }
  }
  const scanned = await scanSessionsByIds([...candidates]);
  const byScanId = new Map(scanned.map((s) => [s.id, s]));
  debugLog(
    `[api/sessions/by-ids] scanSessionsByIds(${candidates.size} ids for ${requested.length} pins) took ${(performance.now() - t0).toFixed(0)}ms`,
  );

  const manager = getSessionManager();
  const activeMap = new Map(manager.listActiveSessions().map((s) => [s.id, s]));
  const knownMap = new Map(manager.listKnownSessions().map((s) => [s.id, s]));

  const sessions: SessionInfo[] = [];
  const found = new Set<string>();
  const seen = new Set<string>();
  for (const id of requested) {
    const prefs = prefsById.get(id);
    const chain = [prefs?.cliSessionId, id, ...(prefs?.previousCliSessionIds ?? [])].filter((c): c is string => !!c);
    // A session created in this process but not yet written to a transcript is
    // only in the manager, under the id it was created with.
    const hit = chain.map((c) => byScanId.get(c) ?? knownMap.get(c)).find((s): s is SessionInfo => !!s);
    if (!hit || seen.has(hit.id)) continue;
    seen.add(hit.id);
    found.add(id);

    const session: SessionInfo = { ...hit, id };
    const running = activeMap.get(hit.id) ?? activeMap.get(id);
    if (running) {
      session.status = running.status;
      session.pendingRequestCount = running.pendingRequestCount;
      // Live-only, like the two above. This route backs the sidebar's poll, so
      // leaving it out overwrote the websocket's count with undefined every few
      // seconds and the background-agent dot went out.
      session.agentCount = running.agentCount;
    }
    const mem = knownMap.get(hit.id) ?? knownMap.get(id);
    if (mem) {
      session.name = mem.name;
    }
    sessions.push(session);
  }

  return NextResponse.json({ sessions, foundIds: [...found] });
}
