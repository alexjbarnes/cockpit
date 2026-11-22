import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { isCwdIgnored } from "@/lib/ignored-folders";
import { isUserSetName, scannedSessionName } from "@/lib/session-name";
import { validateSession } from "@/server/auth";
import { getDefaults } from "@/server/defaults";
import { getJobSessionIds } from "@/server/job-storage";
import { getCockpitDir } from "@/server/paths";
import { getSessionPrefs } from "@/server/session-prefs";
import { getSessionManager } from "@/server/singleton";
import { scanSessionsForCwd } from "@/server/transcript";
import { getWorkflowSessionIds } from "@/server/workflow-storage";
import type { SessionInfo } from "@/types";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cwd = req.nextUrl.searchParams.get("cwd");
  if (!cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }

  if (cwd === getCockpitDir()) {
    return NextResponse.json({ sessions: [] });
  }

  const ignoredFolders = getDefaults().ignoredSessionFolders;
  if (isCwdIgnored(cwd, ignoredFolders)) {
    return NextResponse.json({ sessions: [] });
  }

  const sessions = await scanSessionsForCwd(cwd);

  const manager = getSessionManager();
  const activeMap = new Map(manager.listActiveSessions().map((s) => [s.id, s]));
  const knownMap = new Map(manager.listKnownSessions().map((s) => [s.id, s]));

  const onDiskIds = new Set<string>();
  for (const session of sessions) {
    onDiskIds.add(session.id);
    const running = activeMap.get(session.id);
    if (running) {
      session.status = running.status;
      session.pendingRequestCount = running.pendingRequestCount;
    }
    const mem = knownMap.get(session.id);
    if (mem) {
      // The scan has the stored title (or the first prompt); the memory entry
      // is often still the folder's basename. A user-set name wins over both.
      const folder = path.basename(session.cwd) || session.cwd;
      const prefsName = getSessionPrefs(session.id)?.name;
      session.name = scannedSessionName(session.name, mem.name, isUserSetName(prefsName, folder) ? prefsName : null);
    }
  }

  // Include in-memory sessions for this cwd that have no transcript file yet
  for (const mem of knownMap.values()) {
    if (mem.cwd === cwd && !onDiskIds.has(mem.id)) {
      sessions.push(mem);
    }
  }

  const JOB_TITLE_PREFIX = "You are running as an autonomous scheduled job";
  // A workflow's run is hidden the same way: it is reached from its issue.
  const jobSessionIds = new Set([...getJobSessionIds(), ...getWorkflowSessionIds()]);
  const filtered: SessionInfo[] = sessions.filter(
    (s) =>
      !isCwdIgnored(s.cwd, ignoredFolders) &&
      !jobSessionIds.has(s.id) &&
      !s.name?.startsWith("[job] ") &&
      !s.name?.startsWith(JOB_TITLE_PREFIX),
  );
  filtered.sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  return NextResponse.json({ sessions: filtered });
}
