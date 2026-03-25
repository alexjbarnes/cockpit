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

  it("destroys sessions", async () => {
    const { createSession, validateSession, destroySession } = await import("@/server/auth");
    const token = createSession();
    expect(validateSession(token)).toBe(true);
    destroySession(token);
    expect(validateSession(token)).toBe(false);
  });

  it("bypasses validation when auth disabled", async () => {
    process.env.COCKPIT_DISABLE_AUTH = "true";
    const { validateSession } = await import("@/server/auth");
    expect(validateSession("anything")).toBe(true);
  });
});
