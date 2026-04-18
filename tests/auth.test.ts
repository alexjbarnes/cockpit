import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PASSWORD_FILE = path.join(homedir(), ".cockpit", "password.json");

function cleanupPasswordFile() {
  if (existsSync(PASSWORD_FILE)) unlinkSync(PASSWORD_FILE);
}

describe("auth", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.COCKPIT_DISABLE_AUTH;
    cleanupPasswordFile();
  });

  afterEach(() => {
    cleanupPasswordFile();
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
    const { setupPassword, createSession, validateSession } = await import("@/server/auth");
    await setupPassword("test");
    const token = createSession();
    expect(validateSession(token)).toBe(true);
    expect(validateSession("bogus")).toBe(false);
  });

  it("destroySession is a no-op for stateless signed tokens", async () => {
    const { setupPassword, createSession, validateSession, destroySession } = await import("@/server/auth");
    await setupPassword("test");
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
    const { setupPassword, createSession, isAuthenticated } = await import("@/server/auth");
    await setupPassword("test");
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

  it("validateSession returns false for empty token", async () => {
    const { validateSession } = await import("@/server/auth");
    expect(validateSession("")).toBe(false);
  });

  it("validateSession returns false for token without dot separator", async () => {
    const { validateSession } = await import("@/server/auth");
    expect(validateSession("nodottoken")).toBe(false);
  });

  it("validateSession returns false for token with wrong signature length", async () => {
    const { validateSession } = await import("@/server/auth");
    expect(validateSession("abc.tooshort")).toBe(false);
  });

  it("isAuthDisabled returns false by default", async () => {
    const { isAuthDisabled } = await import("@/server/auth");
    expect(isAuthDisabled()).toBe(false);
  });

  it("isAuthDisabled returns true when env var is set", async () => {
    process.env.COCKPIT_DISABLE_AUTH = "true";
    const { isAuthDisabled } = await import("@/server/auth");
    expect(isAuthDisabled()).toBe(true);
  });

  describe("needsSetup", () => {
    it("returns false when auth is disabled", async () => {
      process.env.COCKPIT_DISABLE_AUTH = "true";
      const { needsSetup } = await import("@/server/auth");
      expect(needsSetup()).toBe(false);
    });

    it("returns true when no password file exists", async () => {
      const { needsSetup } = await import("@/server/auth");
      expect(needsSetup()).toBe(true);
    });
  });

  describe("setupPassword and verifyPassword", () => {
    it("sets up password and verifies it correctly", async () => {
      const { setupPassword, verifyPassword } = await import("@/server/auth");
      await setupPassword("my-secret");
      expect(await verifyPassword("my-secret")).toBe(true);
    });

    it("rejects wrong password", async () => {
      const { setupPassword, verifyPassword } = await import("@/server/auth");
      await setupPassword("my-secret");
      expect(await verifyPassword("wrong-password")).toBe(false);
    });

    it("verifyPassword returns false when no password is stored", async () => {
      const { verifyPassword } = await import("@/server/auth");
      expect(await verifyPassword("anything")).toBe(false);
    });

    it("needsSetup returns false after setupPassword", async () => {
      const { setupPassword, needsSetup } = await import("@/server/auth");
      await setupPassword("my-secret");
      expect(needsSetup()).toBe(false);
    });
  });

  describe("deletePasswordFile", () => {
    it("resets cached password so needsSetup returns true", async () => {
      const { setupPassword, needsSetup, deletePasswordFile } = await import("@/server/auth");
      await setupPassword("my-secret");
      expect(needsSetup()).toBe(false);
      await deletePasswordFile();
      expect(needsSetup()).toBe(true);
    });

    it("is a no-op when password file does not exist", async () => {
      const { deletePasswordFile } = await import("@/server/auth");
      await expect(deletePasswordFile()).resolves.toBeUndefined();
    });
  });

  describe("signed token lifecycle", () => {
    it("createSession returns empty string when no password is set", async () => {
      const { createSession } = await import("@/server/auth");
      expect(createSession()).toBe("");
    });

    it("validates tokens after password setup", async () => {
      const { setupPassword, createSession, validateSession } = await import("@/server/auth");
      await setupPassword("test-pass");
      const token = createSession();
      expect(token).not.toBe("");
      expect(validateSession(token)).toBe(true);
    });

    it("invalidates tokens after password change", async () => {
      const { setupPassword, createSession, validateSession } = await import("@/server/auth");
      await setupPassword("pass1");
      const token = createSession();
      expect(validateSession(token)).toBe(true);

      await setupPassword("pass2");
      expect(validateSession(token)).toBe(false);
    });

    it("validateSession returns false when no signing key exists", async () => {
      const { validateSession } = await import("@/server/auth");
      expect(validateSession("abc.def")).toBe(false);
    });

    it("validateSession returns false for mismatched signature length", async () => {
      const { setupPassword, createSession, validateSession } = await import("@/server/auth");
      await setupPassword("test");
      const token = createSession();
      const tampered = token.slice(0, token.indexOf(".") + 1) + "short";
      expect(validateSession(tampered)).toBe(false);
    });
  });

  describe("extractTokenFromQuery", () => {
    it("extracts token from query string", async () => {
      const { extractTokenFromQuery } = await import("@/server/auth");
      expect(extractTokenFromQuery("/ws?token=abc123")).toBe("abc123");
    });

    it("returns null when no token param", async () => {
      const { extractTokenFromQuery } = await import("@/server/auth");
      expect(extractTokenFromQuery("/ws")).toBeNull();
    });
  });

  describe("verifyPassword", () => {
    it("returns false for wrong password", async () => {
      const { setupPassword, verifyPassword } = await import("@/server/auth");
      await setupPassword("correct-password");
      const result = await verifyPassword("wrong-password");
      expect(result).toBe(false);
    });
  });
});
