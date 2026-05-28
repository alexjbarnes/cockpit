import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("node:fs");
vi.mock("node:os", () => ({ homedir: () => "/home/user" }));
vi.mock("node:path", async () => {
  const actual = await vi.importActual("node:path");
  return { ...actual, join: (...args: string[]) => args.join("/") };
});

describe("job-storage context migration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("splits a legacy [1m] suffix on getJob", async () => {
    const fs = await import("node:fs");
    const stored = JSON.stringify({
      jobs: [
        { id: "job-1", name: "x", model: "claude-opus-4-7[1m]" },
      ],
    });
    vi.mocked(fs.readFileSync).mockReturnValue(stored as never);

    const { getJob } = await import("@/server/job-storage");
    const job = getJob("job-1");

    expect(job?.model).toBe("claude-opus-4-7");
    expect(job?.contextSize).toBe("1m");
  });
});
