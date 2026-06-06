import { describe, expect, it } from "vitest";
import { clearToken, isValidToken, lookupRunContext, registerAuthToken, registerRunContext } from "@/server/mcp/run-context";

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
});
