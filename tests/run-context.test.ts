import { describe, expect, it } from "vitest";
import {
  clearToken,
  isValidToken,
  lookupCaller,
  lookupRunContext,
  registerAuthToken,
  registerRunContext,
  registerSessionContext,
} from "@/server/mcp/run-context";

describe("run-context", () => {
  it("registerAuthToken makes token valid with null context", () => {
    const token = "auth-only-token-1";
    registerAuthToken(token);
    expect(isValidToken(token)).toBe(true);
    expect(lookupRunContext(token)).toBeNull();
  });

  it("registerRunContext makes token valid with job context", () => {
    const token = "run-context-token-1";
    const ctx = { jobId: "job-1", jobName: "My Job", runId: "run-1" };
    registerRunContext(token, ctx);
    expect(isValidToken(token)).toBe(true);
    expect(lookupRunContext(token)).toEqual(ctx);
  });

  it("lookupRunContext returns null after clearToken", () => {
    const token = "clear-token-1";
    registerAuthToken(token);
    expect(isValidToken(token)).toBe(true);
    clearToken(token);
    expect(isValidToken(token)).toBe(false);
    expect(lookupRunContext(token)).toBeNull();
  });

  it("isValidToken returns false for unknown token", () => {
    expect(isValidToken("nonexistent-token-xyz")).toBe(false);
  });

  it("lookupRunContext returns null for unknown token", () => {
    expect(lookupRunContext("nonexistent-token-xyz")).toBeNull();
  });

  it("notifyProviders is preserved in RunContext", () => {
    const token = "notify-token-1";
    const ctx = { jobId: "j", jobName: "n", runId: "r", notifyProviders: ["slack"] };
    registerRunContext(token, ctx);
    expect(lookupRunContext(token)?.notifyProviders).toEqual(["slack"]);
  });

  describe("McpCaller (assistant / job / session tagged union)", () => {
    it("registerAuthToken produces an assistant caller", () => {
      const token = "caller-assistant-1";
      registerAuthToken(token);
      expect(lookupCaller(token)).toEqual({ kind: "assistant" });
    });

    it("registerRunContext produces a job caller carrying the RunContext", () => {
      const token = "caller-job-1";
      const ctx = { jobId: "job-1", jobName: "My Job", runId: "run-1" };
      registerRunContext(token, ctx);
      expect(lookupCaller(token)).toEqual({ kind: "job", run: ctx });
    });

    it("registerSessionContext produces a session caller carrying sessionId and sessionName", () => {
      const token = "caller-session-1";
      registerSessionContext(token, "session-abc", "My Session");
      expect(lookupCaller(token)).toEqual({ kind: "session", sessionId: "session-abc", sessionName: "My Session" });
    });

    it("lookupCaller returns null for an unknown token", () => {
      expect(lookupCaller("nonexistent-token-xyz")).toBeNull();
    });

    it("lookupCaller returns null after clearToken", () => {
      const token = "caller-clear-1";
      registerSessionContext(token, "session-1", "Session One");
      expect(lookupCaller(token)).not.toBeNull();
      clearToken(token);
      expect(lookupCaller(token)).toBeNull();
    });

    it("lookupRunContext returns null for a session caller", () => {
      const token = "caller-session-2";
      registerSessionContext(token, "session-2", "Session Two");
      expect(lookupRunContext(token)).toBeNull();
    });

    it("isValidToken is true for a registered session token", () => {
      const token = "caller-session-3";
      registerSessionContext(token, "session-3", "Session Three");
      expect(isValidToken(token)).toBe(true);
    });
  });
});
