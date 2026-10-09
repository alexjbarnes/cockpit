import { describe, expect, it } from "vitest";
import { assistantDot } from "@/lib/assistant-dot";

describe("assistantDot", () => {
  it("shows nothing when the assistant is idle and read", () => {
    expect(assistantDot({ status: "idle", pendingRequestCount: 0, unread: false })).toBeNull();
  });

  it("shows green for a turn that ended unseen", () => {
    expect(assistantDot({ status: "idle", pendingRequestCount: 0, unread: true })).toBe("unread");
  });

  it("shows yellow while a turn is in flight", () => {
    expect(assistantDot({ status: "running", pendingRequestCount: 0, unread: false })).toBe("working");
  });

  it("shows blue for a question or permission prompt", () => {
    expect(assistantDot({ status: "idle", pendingRequestCount: 1, unread: true })).toBe("pending");
  });

  it("lets a pending prompt outrank a running turn", () => {
    expect(assistantDot({ status: "running", pendingRequestCount: 2, unread: false })).toBe("pending");
  });

  it("lets a running turn outrank an unread one", () => {
    expect(assistantDot({ status: "running", pendingRequestCount: 0, unread: true })).toBe("working");
  });
});
