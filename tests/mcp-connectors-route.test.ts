// The MCP authentication route: it hands the CLI's own sign-in flow to the page
// and keeps a pending one alive between the two requests that drive it.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth", () => ({
  validateSession: (token: string) => token === "valid",
}));

const auth = vi.hoisted(() => ({
  listClaudeMcpServers: vi.fn(),
  startMcpLogin: vi.fn(),
  submitLoginRedirect: vi.fn(),
  cancelLogin: vi.fn(),
  logoutMcpServer: vi.fn(),
}));

vi.mock("@/server/mcp-auth", () => auth);

import { DELETE, GET, POST } from "@/app/api/mcp-servers/connectors/route";

function req(method: string, body?: unknown, query = "", token?: string): NextRequest {
  return new NextRequest(`http://localhost/api/mcp-servers/connectors${query}`, {
    method,
    headers: token ? { cookie: `cockpit_session=${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/mcp-servers/connectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses every method without a session", async () => {
    expect((await GET(req("GET"))).status).toBe(401);
    expect((await POST(req("POST", { action: "login", name: "conduit" }))).status).toBe(401);
    expect((await DELETE(req("DELETE", undefined, "?id=abc"))).status).toBe(401);
  });

  it("lists the servers the CLI reports", async () => {
    auth.listClaudeMcpServers.mockResolvedValue({ servers: [{ name: "claude.ai Todoist" }], checkedAt: 5 });

    const res = await GET(req("GET", undefined, "?cwd=/work/repo&refresh=1", "valid"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ servers: [{ name: "claude.ai Todoist" }], checkedAt: 5 });
    expect(auth.listClaudeMcpServers).toHaveBeenCalledWith({ cwd: "/work/repo", force: true });
  });

  it("reports a list that could not be produced", async () => {
    auth.listClaudeMcpServers.mockRejectedValue(new Error("claude is not installed"));

    const res = await GET(req("GET", undefined, "", "valid"));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "claude is not installed" });
  });

  describe("login", () => {
    it("needs a server name", async () => {
      const res = await POST(req("POST", { action: "login" }, "", "valid"));

      expect(res.status).toBe(400);
      expect(auth.startMcpLogin).not.toHaveBeenCalled();
    });

    it("returns the authorisation URL the CLI printed", async () => {
      auth.startMcpLogin.mockResolvedValue({ ok: true, kind: "connector", name: "claude.ai Todoist", url: "https://claude.ai/x" });

      const res = await POST(req("POST", { action: "login", name: "claude.ai Todoist", cwd: "/work/repo" }, "", "valid"));

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ kind: "connector", url: "https://claude.ai/x" });
      expect(auth.startMcpLogin).toHaveBeenCalledWith("claude.ai Todoist", "/work/repo");
    });

    it("reports a sign-in the CLI would not start", async () => {
      auth.startMcpLogin.mockResolvedValue({ ok: false, error: 'No MCP server named "nope".' });

      const res = await POST(req("POST", { action: "login", name: "nope" }, "", "valid"));

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'No MCP server named "nope".' });
    });
  });

  describe("submit", () => {
    it("needs both the sign-in id and the redirect URL", async () => {
      expect((await POST(req("POST", { action: "submit", id: "abc" }, "", "valid"))).status).toBe(400);
      expect((await POST(req("POST", { action: "submit", redirectUrl: "http://x/cb" }, "", "valid"))).status).toBe(400);
    });

    it("passes the pasted URL to the waiting sign-in", async () => {
      auth.submitLoginRedirect.mockResolvedValue({ ok: true });

      const res = await POST(req("POST", { action: "submit", id: "abc", redirectUrl: "  http://localhost:1/cb  " }, "", "valid"));

      expect(res.status).toBe(200);
      expect(auth.submitLoginRedirect).toHaveBeenCalledWith("abc", "http://localhost:1/cb");
    });

    it("reports a URL the CLI rejected", async () => {
      auth.submitLoginRedirect.mockResolvedValue({ ok: false, error: "Invalid authorization URL" });

      const res = await POST(req("POST", { action: "submit", id: "abc", redirectUrl: "nope" }, "", "valid"));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid authorization URL" });
    });
  });

  describe("logout", () => {
    it("needs a server name", async () => {
      expect((await POST(req("POST", { action: "logout" }, "", "valid"))).status).toBe(400);
    });

    it("clears the credentials", async () => {
      auth.logoutMcpServer.mockResolvedValue({ ok: true, stdout: "", stderr: "" });

      expect((await POST(req("POST", { action: "logout", name: "conduit" }, "", "valid"))).status).toBe(200);
      expect(auth.logoutMcpServer).toHaveBeenCalledWith("conduit", undefined);
    });

    it("reports what the CLI said when it refuses", async () => {
      auth.logoutMcpServer.mockResolvedValue({ ok: false, stdout: "", stderr: "not signed in" });

      const res = await POST(req("POST", { action: "logout", name: "conduit" }, "", "valid"));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "not signed in" });
    });
  });

  it("refuses an action it does not know", async () => {
    const res = await POST(req("POST", { action: "dance" }, "", "valid"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown action: dance" });
  });

  it("cancels a sign-in that is still waiting", async () => {
    auth.cancelLogin.mockReturnValue(true);

    const res = await DELETE(req("DELETE", undefined, "?id=abc", "valid"));

    expect(await res.json()).toEqual({ ok: true });
    expect(auth.cancelLogin).toHaveBeenCalledWith("abc");
  });

  it("needs an id to cancel", async () => {
    expect((await DELETE(req("DELETE", undefined, "", "valid"))).status).toBe(400);
  });
});
