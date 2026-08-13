// The session-list routes serve rows built from transcript files on disk, then
// overlay the fields only a live session knows. Miss one and the sidebar's poll
// silently undoes what the websocket just delivered: agentCount reached the
// client over `session:agents`, the poll a few seconds later replaced the row
// with undefined, and the background-agent dot went out. Status and
// pendingRequestCount were already overlaid; agentCount was not.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@/types";

const h = vi.hoisted(() => ({
  scanAllSessions: vi.fn(),
  scanSessionsForCwd: vi.fn(),
  scanSessionsByIds: vi.fn(),
  listActiveSessions: vi.fn((): unknown[] => []),
  listKnownSessions: vi.fn((): unknown[] => []),
}));

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));
vi.mock("@/server/debug-logger", () => ({ debugLog: vi.fn() }));
vi.mock("@/server/paths", () => ({ getCockpitDir: () => "/tmp/cockpit-config" }));
vi.mock("@/server/transcript", () => ({
  scanAllSessions: h.scanAllSessions,
  scanSessionsForCwd: h.scanSessionsForCwd,
  scanSessionsByIds: h.scanSessionsByIds,
}));
vi.mock("@/server/singleton", () => ({
  getSessionManager: () => ({
    listActiveSessions: h.listActiveSessions,
    listKnownSessions: h.listKnownSessions,
  }),
}));

import { GET as GET_BY_IDS } from "@/app/api/sessions/by-ids/route";
import { GET as GET_LIST } from "@/app/api/sessions/route";

// What a scan builds: no knowledge of anything running.
function onDisk(id: string): SessionInfo {
  return { id, name: "s", cwd: "/w", createdAt: 1, lastActiveAt: 1, status: "idle", pendingRequestCount: 0 } as SessionInfo;
}

// What the session manager holds for the same session, mid-flight.
function live(id: string): SessionInfo {
  return {
    id,
    name: "s",
    cwd: "/w",
    createdAt: 1,
    lastActiveAt: 1,
    status: "idle",
    pendingRequestCount: 2,
    agentCount: 3,
  } as SessionInfo;
}

function authedReq(url: string): NextRequest {
  return new NextRequest(url, { headers: { cookie: "cockpit_session=valid" } });
}

describe("live-only session fields survive the poll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.listKnownSessions.mockReturnValue([]);
  });

  it("GET /api/sessions/by-ids overlays agentCount from the running session", async () => {
    h.scanSessionsByIds.mockResolvedValue([onDisk("s1")]);
    h.listActiveSessions.mockReturnValue([live("s1")]);

    const res = await GET_BY_IDS(authedReq("http://localhost/api/sessions/by-ids?ids=s1"));
    const body = (await res.json()) as { sessions: SessionInfo[] };

    expect(body.sessions[0].agentCount, "the sidebar polls this route every few seconds").toBe(3);
    expect(body.sessions[0].pendingRequestCount).toBe(2);
  });

  it("GET /api/sessions overlays agentCount from the running session", async () => {
    h.scanAllSessions.mockResolvedValue([{ cwd: "/w", dirName: "w", sessions: [onDisk("s1")], totalSessionCount: 1 }]);
    h.listActiveSessions.mockReturnValue([live("s1")]);

    const res = await GET_LIST(authedReq("http://localhost/api/sessions"));
    const body = (await res.json()) as { groups: { sessions: SessionInfo[] }[] };

    expect(body.groups[0].sessions[0].agentCount).toBe(3);
  });

  it("leaves agentCount alone for a session that is not running", async () => {
    h.scanSessionsByIds.mockResolvedValue([onDisk("s1")]);
    h.listActiveSessions.mockReturnValue([]);

    const res = await GET_BY_IDS(authedReq("http://localhost/api/sessions/by-ids?ids=s1"));
    const body = (await res.json()) as { sessions: SessionInfo[] };

    expect(body.sessions[0].agentCount).toBeUndefined();
  });
});
