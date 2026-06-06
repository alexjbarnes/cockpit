import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@/types";

const COCKPIT_DIR = "/tmp/cockpit-config";

const h = vi.hoisted(() => ({
  scanAllSessions: vi.fn(),
  scanSessionsForCwd: vi.fn(),
  listActiveSessions: vi.fn((): unknown[] => []),
  listKnownSessions: vi.fn((): unknown[] => []),
}));

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));
vi.mock("@/server/debug-logger", () => ({ debugLog: vi.fn() }));
vi.mock("@/server/paths", () => ({ getCockpitDir: () => COCKPIT_DIR }));
vi.mock("@/server/transcript", () => ({
  scanAllSessions: h.scanAllSessions,
  scanSessionsForCwd: h.scanSessionsForCwd,
}));
vi.mock("@/server/singleton", () => ({
  getSessionManager: () => ({
    listActiveSessions: h.listActiveSessions,
    listKnownSessions: h.listKnownSessions,
  }),
}));

import { GET as GET_GROUP } from "@/app/api/sessions/group/route";
import { GET as GET_LIST } from "@/app/api/sessions/route";

function session(id: string, cwd: string, name: string): SessionInfo {
  return {
    id,
    name,
    cwd,
    createdAt: 1,
    lastActiveAt: 1,
    status: "idle",
    pendingRequestCount: 0,
  } as SessionInfo;
}

function authedReq(url: string): NextRequest {
  return new NextRequest(url, { headers: { cookie: "cockpit_session=valid" } });
}

describe("GET /api/sessions cockpit-agent exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.listActiveSessions.mockReturnValue([]);
    h.listKnownSessions.mockReturnValue([]);
  });

  it("excludes the cockpit dir group whether it is on disk or in memory only", async () => {
    h.scanAllSessions.mockResolvedValue([
      {
        cwd: COCKPIT_DIR,
        dirName: "cockpit-config",
        sessions: [session("disk-1", COCKPIT_DIR, "Cockpit Assistant")],
        totalSessionCount: 1,
      },
      { cwd: "/home/dev/proj", dirName: "proj", sessions: [session("proj-1", "/home/dev/proj", "proj")], totalSessionCount: 1 },
    ]);
    // an in-memory cockpit session with no transcript yet
    h.listKnownSessions.mockReturnValue([session("mem-1", COCKPIT_DIR, "Cockpit Assistant")]);

    const res = await GET_LIST(authedReq("http://localhost/api/sessions"));
    const body = await res.json();

    const cwds = body.groups.map((g: { cwd: string }) => g.cwd);
    expect(cwds).not.toContain(COCKPIT_DIR);
    expect(cwds).toContain("/home/dev/proj");
    const allIds = body.groups.flatMap((g: { sessions: SessionInfo[] }) => g.sessions.map((s) => s.id));
    expect(allIds).not.toContain("disk-1");
    expect(allIds).not.toContain("mem-1");
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await GET_LIST(new NextRequest("http://localhost/api/sessions"));
    expect(res.status).toBe(401);
  });

  it("merges live status/name, drops job sessions, and adds in-memory-only groups", async () => {
    const running = session("act-1", "/home/dev/proj", "on-disk-name");
    const job = session("job-1", "/home/dev/proj", "[job] nightly");
    h.scanAllSessions.mockResolvedValue([{ cwd: "/home/dev/proj", dirName: "proj", sessions: [running, job], totalSessionCount: 2 }]);
    h.listActiveSessions.mockReturnValue([{ id: "act-1", status: "running", pendingRequestCount: 4, name: "x", cwd: "/home/dev/proj" }]);
    h.listKnownSessions.mockReturnValue([
      { ...session("act-1", "/home/dev/proj", "Renamed"), status: "running" },
      // in-memory session in a cwd with no transcript group yet -> creates a new group
      session("mem-new", "/home/dev/other", "Fresh"),
    ]);

    const res = await GET_LIST(authedReq("http://localhost/api/sessions"));
    const body = await res.json();

    const proj = body.groups.find((g: { cwd: string }) => g.cwd === "/home/dev/proj");
    const merged = proj.sessions.find((s: SessionInfo) => s.id === "act-1");
    expect(merged.status).toBe("running");
    expect(merged.pendingRequestCount).toBe(4);
    expect(merged.name).toBe("Renamed");
    // the job session is filtered out
    expect(proj.sessions.map((s: SessionInfo) => s.id)).not.toContain("job-1");
    // the in-memory-only session forms its own group
    expect(body.groups.map((g: { cwd: string }) => g.cwd)).toContain("/home/dev/other");
  });

  it("returns only review sessions for type=reviews", async () => {
    h.scanAllSessions.mockResolvedValue([
      {
        cwd: "/home/dev/.cockpit/reviews/r1",
        dirName: "r1",
        sessions: [session("rev-1", "/home/dev/.cockpit/reviews/r1", "review")],
        totalSessionCount: 1,
      },
      { cwd: "/home/dev/proj", dirName: "proj", sessions: [session("proj-1", "/home/dev/proj", "proj")], totalSessionCount: 1 },
    ]);

    const res = await GET_LIST(authedReq("http://localhost/api/sessions?type=reviews"));
    const body = await res.json();

    expect(body.sessions.map((s: SessionInfo) => s.id)).toEqual(["rev-1"]);
  });
});

describe("GET /api/sessions/group cockpit-agent exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.listActiveSessions.mockReturnValue([]);
    h.listKnownSessions.mockReturnValue([]);
  });

  it("returns no sessions for the cockpit dir regardless of what is on disk", async () => {
    h.scanSessionsForCwd.mockResolvedValue([session("disk-1", COCKPIT_DIR, "Cockpit Assistant")]);

    const res = await GET_GROUP(authedReq(`http://localhost/api/sessions/group?cwd=${encodeURIComponent(COCKPIT_DIR)}`));
    const body = await res.json();

    expect(body.sessions).toEqual([]);
    expect(h.scanSessionsForCwd).not.toHaveBeenCalled();
  });

  it("still lists sessions for a normal cwd", async () => {
    h.scanSessionsForCwd.mockResolvedValue([session("proj-1", "/home/dev/proj", "proj")]);

    const res = await GET_GROUP(authedReq("http://localhost/api/sessions/group?cwd=/home/dev/proj"));
    const body = await res.json();

    expect(body.sessions.map((s: SessionInfo) => s.id)).toContain("proj-1");
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await GET_GROUP(new NextRequest("http://localhost/api/sessions/group?cwd=/home/dev/proj"));
    expect(res.status).toBe(401);
  });

  it("returns 400 when cwd is missing", async () => {
    const res = await GET_GROUP(authedReq("http://localhost/api/sessions/group"));
    expect(res.status).toBe(400);
  });

  it("merges live status/name, drops job sessions, and adds in-memory-only sessions", async () => {
    h.scanSessionsForCwd.mockResolvedValue([
      session("disk-1", "/home/dev/proj", "on-disk"),
      session("job-1", "/home/dev/proj", "[job] nightly"),
    ]);
    h.listActiveSessions.mockReturnValue([{ id: "disk-1", status: "running", pendingRequestCount: 2, name: "x", cwd: "/home/dev/proj" }]);
    h.listKnownSessions.mockReturnValue([
      { ...session("disk-1", "/home/dev/proj", "Renamed"), status: "running" },
      session("mem-1", "/home/dev/proj", "In-memory"),
    ]);

    const res = await GET_GROUP(authedReq("http://localhost/api/sessions/group?cwd=/home/dev/proj"));
    const body = await res.json();

    const ids = body.sessions.map((s: SessionInfo) => s.id);
    expect(ids).toContain("disk-1");
    expect(ids).toContain("mem-1");
    expect(ids).not.toContain("job-1");
    const merged = body.sessions.find((s: SessionInfo) => s.id === "disk-1");
    expect(merged.status).toBe("running");
    expect(merged.name).toBe("Renamed");
  });
});
