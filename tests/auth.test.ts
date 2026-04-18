import { describe, it, expect, beforeEach } from "vitest";

describe("auth", () => {
  beforeEach(() => {
    // Reset modules between tests so cached state is cleared
    delete process.env.COCKPIT_DISABLE_AUTH;
  });

  it("extracts token from query string", async () => {
    const { extractTokenFromQuery } = await import("@/server/auth");
    expect(extractTokenFromQuery("/ws?token=abc123")).toBe("abc123");
  });

  it("returns null for query without token", async () => {
    const { extractTokenFromQuery } = await import("@/server/auth");
    expect(extractTokenFromQuery("/ws")).toBeNull();
  });

  it("extracts token from authorization header", async () => {
    const { extractTokenFromRequest } = await import("@/server/auth");
    const req = {
      headers: { authorization: "Bearer my-token" },
    } as unknown as import("node:http").IncomingMessage;
    expect(extractTokenFromRequest(req)).toBe("my-token");
  });

  it("extracts token from cookie", async () => {
    const { extractTokenFromRequest } = await import("@/server/auth");
    const req = {
      headers: { cookie: "cockpit_session=session-token; other=val" },
    } as unknown as import("node:http").IncomingMessage;
    expect(extractTokenFromRequest(req)).toBe("session-token");
  });

  it("returns null when no auth present", async () => {
    const { extractTokenFromRequest } = await import("@/server/auth");
    const req = {
      headers: {},
    } as unknown as import("node:http").IncomingMessage;
    expect(extractTokenFromRequest(req)).toBeNull();
  });

  it("creates and validates sessions", async () => {
    const { createSession, validateSession } = await import("@/server/auth");
    const token = createSession();
    expect(validateSession(token)).toBe(true);
    expect(validateSession("bogus")).toBe(false);
  });

  it("destroySession is a no-op for stateless signed tokens", async () => {
    const { createSession, validateSession, destroySession } = await import("@/server/auth");
    const token = createSession();
    expect(validateSession(token)).toBe(true);
    destroySession(token);
    expect(validateSession(token)).toBe(true);
  });

  it("bypasses validation when auth disabled", async () => {
    process.env.COCKPIT_DISABLE_AUTH = "true";
    const { validateSession } = await import("@/server/auth");
    expect(validateSession("anything")).toBe(true);
  });

  it("isAuthenticated returns true when valid token in header", async () => {
    const { createSession, isAuthenticated } = await import("@/server/auth");
    const token = createSession();
    const req = {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as import("node:http").IncomingMessage;
    expect(isAuthenticated(req)).toBe(true);
  });

  it("isAuthenticated returns false when no token present", async () => {
    const { isAuthenticated } = await import("@/server/auth");
    const req = {
      headers: {},
    } as unknown as import("node:http").IncomingMessage;
    expect(isAuthenticated(req)).toBe(false);
  });

  it("isAuthenticated returns true when auth is disabled", async () => {
    process.env.COCKPIT_DISABLE_AUTH = "true";
    const { isAuthenticated } = await import("@/server/auth");
    const req = {
      headers: {},
    } as unknown as import("node:http").IncomingMessage;
    expect(isAuthenticated(req)).toBe(true);
  });

  it("setSessionCookie sets correct cookie header", async () => {
    const { setSessionCookie } = await import("@/server/auth");
    const res = {
      setHeader: (key: string, value: string) => {
        expect(key).toBe("Set-Cookie");
        expect(value).toContain("cockpit_session=test-token");
        expect(value).toContain("HttpOnly");
        expect(value).toContain("SameSite=Strict");
      },
    } as unknown as import("node:http").ServerResponse;
    setSessionCookie(res, "test-token");
  });

  it("clearSessionCookie sets Max-Age=0", async () => {
    const { clearSessionCookie } = await import("@/server/auth");
    const res = {
      setHeader: (key: string, value: string) => {
        expect(key).toBe("Set-Cookie");
        expect(value).toContain("Max-Age=0");
      },
    } as unknown as import("node:http").ServerResponse;
    clearSessionCookie(res);
  });

  it("extractTokenFromQuery returns null for malformed URL", async () => {
    const { extractTokenFromQuery } = await import("@/server/auth");
    expect(extractTokenFromQuery("ht!tp://invalid")).toBeNull();
  });

  it("extractTokenFromRequest returns null when cookie missing cockpit_session", async () => {
    const { extractTokenFromRequest } = await import("@/server/auth");
    const req = {
      headers: { cookie: "other_cookie=value; another=test" },
    } as unknown as import("node:http").IncomingMessage;
    expect(extractTokenFromRequest(req)).toBeNull();
  });

  it("extractTokenFromRequest prefers authorization header over cookie", async () => {
    const { extractTokenFromRequest } = await import("@/server/auth");
    const req = {
      headers: {
        authorization: "Bearer header-token",
        cookie: "cockpit_session=cookie-token",
      },
    } as unknown as import("node:http").IncomingMessage;
    expect(extractTokenFromRequest(req)).toBe("header-token");
  });
});
