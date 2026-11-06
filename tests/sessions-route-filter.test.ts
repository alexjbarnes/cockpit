import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@/types";

const COCKPIT_DIR = "/tmp/cockpit-config";

const h = vi.hoisted(() => ({
  scanAllSessions: vi.fn(),
  scanSessionsForCwd: vi.fn(),
  scanSessionsByIds: vi.fn(),
  globalSearch: vi.fn(),
  listActiveSessions: vi.fn((): unknown[] => []),
  listKnownSessions: vi.fn((): unknown[] => []),
  ignoredFolders: [] as string[],
}));

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));
vi.mock("@/server/debug-logger", () => ({ debugLog: vi.fn() }));
vi.mock("@/server/paths", () => ({ getCockpitDir: () => COCKPIT_DIR }));
vi.mock("@/server/defaults", async () => {
  const actual = await vi.importActual<typeof import("@/server/defaults")>("@/server/defaults");
  return { ...actual, getDefaults: () => ({ ...actual.getDefaults(), ignoredSessionFolders: h.ignoredFolders }) };
});
vi.mock("@/server/session-prefs", () => ({ getSessionPrefs: () => undefined }));
vi.mock("@/server/transcript", () => ({
  scanAllSessions: h.scanAllSessions,
  scanSessionsForCwd: h.scanSessionsForCwd,
  scanSessionsByIds: h.scanSessionsByIds,
  globalSearch: h.globalSearch,
}));
vi.mock("@/server/singleton", () => ({
  getSessionManager: () => ({
    listActiveSessions: h.listActiveSessions,
    listKnownSessions: h.listKnownSessions,
  }),
}));

import { GET as GET_BY_IDS } from "@/app/api/sessions/by-ids/route";
import { GET as GET_GROUP } from "@/app/api/sessions/group/route";
import { GET as GET_LIST } from "@/app/api/sessions/route";
import { GET as GET_SEARCH } from "@/app/api/sessions/search/route";

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
    h.ignoredFolders = [];
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

  it("hides ignored folders and their descendants, and keeps a sibling", async () => {
    h.ignoredFolders = ["/archive/ai-reviews"];
    h.scanAllSessions.mockResolvedValue([
      {
        cwd: "/archive/ai-reviews",
        dirName: "ai-reviews",
        sessions: [session("ig-1", "/archive/ai-reviews", "ignored")],
        totalSessionCount: 1,
      },
      {
        cwd: "/archive/ai-reviews/nested/deep",
        dirName: "deep",
        sessions: [session("ig-2", "/archive/ai-reviews/nested/deep", "ignored")],
        totalSessionCount: 1,
      },
      {
        cwd: "/archive/ai-reviews-2",
        dirName: "ai-reviews-2",
        sessions: [session("keep-1", "/archive/ai-reviews-2", "kept")],
        totalSessionCount: 1,
      },
    ]);
    h.listKnownSessions.mockReturnValue([session("mem-ig", "/archive/ai-reviews/in-memory", "Fresh")]);

    const res = await GET_LIST(authedReq("http://localhost/api/sessions"));
    const body = await res.json();
    const cwds = body.groups.map((g: { cwd: string }) => g.cwd);

    expect(cwds).not.toContain("/archive/ai-reviews");
    expect(cwds).not.toContain("/archive/ai-reviews/nested/deep");
    expect(cwds).not.toContain("/archive/ai-reviews/in-memory");
    expect(cwds).toContain("/archive/ai-reviews-2");
    const kept = body.groups.find((g: { cwd: string }) => g.cwd === "/archive/ai-reviews-2");
    expect(kept.totalSessionCount).toBe(1);
  });

  it("passes the ignored folders to global search", async () => {
    h.ignoredFolders = ["/archive"];
    h.globalSearch.mockResolvedValue({ results: [], totalFilesSearched: 0, truncated: false });

    const res = await GET_SEARCH(authedReq("http://localhost/api/sessions/search?q=hello%20world"));

    expect(res.status).toBe(200);
    expect(h.globalSearch).toHaveBeenCalledWith("hello world", 50, 0, ["/archive"]);
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
    h.ignoredFolders = [];
  });

  it("returns no sessions for an ignored cwd or a descendant without scanning", async () => {
    h.ignoredFolders = ["/archive"];
    for (const cwd of ["/archive", "/archive/nested"]) {
      const res = await GET_GROUP(authedReq(`http://localhost/api/sessions/group?cwd=${encodeURIComponent(cwd)}`));
      expect((await res.json()).sessions).toEqual([]);
    }
    expect(h.scanSessionsForCwd).not.toHaveBeenCalled();
  });

  it("still lists a sibling that shares the ignored folder's prefix", async () => {
    h.ignoredFolders = ["/archive/reviews"];
    h.scanSessionsForCwd.mockResolvedValue([session("keep-1", "/archive/reviews-2", "kept")]);

    const res = await GET_GROUP(authedReq("http://localhost/api/sessions/group?cwd=/archive/reviews-2"));
    const body = await res.json();

    expect(body.sessions.map((s: SessionInfo) => s.id)).toEqual(["keep-1"]);
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

describe("GET /api/sessions/by-ids ignored folders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.ignoredFolders = [];
  });

  it("omits an ignored pin from sessions and foundIds but leaves the pin stored", async () => {
    h.ignoredFolders = ["/archive"];
    h.scanSessionsByIds.mockResolvedValue([session("ig", "/archive/deep", "ignored"), session("keep", "/repos/cockpit", "kept")]);

    const res = await GET_BY_IDS(authedReq("http://localhost/api/sessions/by-ids?ids=ig,keep"));
    const body = await res.json();

    expect(body.sessions.map((s: SessionInfo) => s.id)).toEqual(["keep"]);
    expect(body.foundIds).toEqual(["keep"]);
  });
});
