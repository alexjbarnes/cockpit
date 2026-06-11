import { describe, expect, it } from "vitest";
import { jobDisplayStatus } from "@/lib/job-display";

describe("jobDisplayStatus", () => {
  it("returns enabled for an enabled, not-triggering job with no lastRunStatus", () => {
    expect(jobDisplayStatus({ enabled: true }, false)).toBe("enabled");
  });

  it("returns enabled for an enabled, not-triggering job that succeeded", () => {
    expect(jobDisplayStatus({ enabled: true, lastRunStatus: "success" }, false)).toBe("enabled");
  });

  it("returns failed for an enabled job that last failed", () => {
    expect(jobDisplayStatus({ enabled: true, lastRunStatus: "failure" }, false)).toBe("failed");
  });

  it("returns failed for an enabled job that timed out", () => {
    expect(jobDisplayStatus({ enabled: true, lastRunStatus: "timeout" }, false)).toBe("failed");
  });

  it("returns running for an enabled server-running job", () => {
    expect(jobDisplayStatus({ enabled: true, lastRunStatus: "running" }, false)).toBe("running");
  });

  it("returns running when isTriggering is true even with no lastRunStatus (never-run)", () => {
    expect(jobDisplayStatus({ enabled: true }, true)).toBe("running");
  });

  it("returns disabled when job is not enabled and not triggering", () => {
    expect(jobDisplayStatus({ enabled: false }, false)).toBe("disabled");
  });

  it("returns running when disabled but triggering (precedence)", () => {
    expect(jobDisplayStatus({ enabled: false }, true)).toBe("running");
  });

  it("returns running when disabled but lastRunStatus is running", () => {
    expect(jobDisplayStatus({ enabled: false, lastRunStatus: "running" }, false)).toBe("running");
  });
});
