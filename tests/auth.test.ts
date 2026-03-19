import { describe, it, expect, beforeAll } from "vitest";

// Set token before importing auth module
beforeAll(() => {
  process.env.COCKPIT_TOKEN = "test-token-abc123";
});

describe("auth", () => {
  it("validates correct token", async () => {
    const { validateToken } = await import("@/server/auth");
    expect(validateToken("test-token-abc123")).toBe(true);
  });

  it("rejects wrong token", async () => {
    const { validateToken } = await import("@/server/auth");
    expect(validateToken("wrong-token")).toBe(false);
  });

  it("rejects empty token", async () => {
    const { validateToken } = await import("@/server/auth");
    expect(validateToken("")).toBe(false);
  });

  it("rejects token with different length", async () => {
    const { validateToken } = await import("@/server/auth");
    expect(validateToken("short")).toBe(false);
  });

  it("returns the token from env", async () => {
    const { getToken } = await import("@/server/auth");
    expect(getToken()).toBe("test-token-abc123");
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
      headers: { cookie: "cockpit_token=cookie-token; other=val" },
    } as unknown as import("node:http").IncomingMessage;
    expect(extractTokenFromRequest(req)).toBe("cookie-token");
  });

  it("returns null when no auth present", async () => {
    const { extractTokenFromRequest } = await import("@/server/auth");
    const req = {
      headers: {},
    } as unknown as import("node:http").IncomingMessage;
    expect(extractTokenFromRequest(req)).toBeNull();
  });
});
