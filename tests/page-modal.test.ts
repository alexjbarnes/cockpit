import { describe, expect, it } from "vitest";
import { isModalPath, pageModalMessage, parsePageModalMessage } from "@/lib/page-modal";

describe("isModalPath", () => {
  it("takes the footer's pages and the pages they link to", () => {
    for (const p of ["/jobs", "/jobs/abc/edit", "/jobs/abc/runs/r1", "/inbox", "/inbox/m1", "/issues", "/issues/CK-1"]) {
      expect(isModalPath(p), p).toBe(true);
    }
    for (const p of ["/settings", "/settings/session", "/agents/reviewer", "/mcp-servers", "/plugins", "/claude-md/edit"]) {
      expect(isModalPath(p), p).toBe(true);
    }
  });

  it("leaves sessions, the home page and reviews to the main window", () => {
    for (const p of ["/", "/sessions/abc", "/reviews", "/reviews/o/r/1", "", "/jobsx"]) {
      expect(isModalPath(p), p).toBe(false);
    }
  });
});

describe("page modal messages", () => {
  it("round-trips each message", () => {
    expect(parsePageModalMessage(pageModalMessage({ type: "ready" }))).toEqual({ type: "ready" });
    expect(parsePageModalMessage(pageModalMessage({ type: "close" }))).toEqual({ type: "close" });
    expect(parsePageModalMessage(pageModalMessage({ type: "open-in-app", url: "/sessions/abc?cwd=%2Ftmp" }))).toEqual({
      type: "open-in-app",
      url: "/sessions/abc?cwd=%2Ftmp",
    });
  });

  it("ignores messages that are not the modal's", () => {
    expect(parsePageModalMessage(null)).toBeNull();
    expect(parsePageModalMessage("ready")).toBeNull();
    expect(parsePageModalMessage({ type: "ready" })).toBeNull();
    expect(parsePageModalMessage({ source: "cockpit-page-modal", type: "other" })).toBeNull();
  });

  it("only opens a path on this origin", () => {
    for (const url of ["https://example.com/x", "//example.com/x", "javascript:alert(1)", 42]) {
      expect(parsePageModalMessage({ source: "cockpit-page-modal", type: "open-in-app", url }), String(url)).toBeNull();
    }
  });
});
