import type { PathLike } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("node:os", () => ({ homedir: () => "/home/user" }));
vi.mock("node:path", async () => {
  const actual = await vi.importActual("node:path");
  return { ...actual, join: (...args: string[]) => args.join("/") };
});

describe("plans", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns undefined when directory does not exist", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { findLatestPlanFile } = await import("@/server/plans");
    const result = findLatestPlanFile();

    expect(result).toBeUndefined();
  });

  it("returns undefined when no .md files", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readdirSync).mockReturnValue(["file.txt", "readme.md.bak"] as unknown as ReturnType<typeof fs.readdirSync>);

    const { findLatestPlanFile } = await import("@/server/plans");
    const result = findLatestPlanFile();

    expect(result).toBeUndefined();
  });

  it("returns latest by mtime", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readdirSync).mockReturnValue(["plan-1.md", "plan-2.md", "plan-3.md"] as unknown as ReturnType<typeof fs.readdirSync>);

    vi.mocked(fs.statSync).mockImplementation((path: PathLike) => {
      const mtimes: Record<string, number> = {
        "/home/user/.claude/plans/plan-1.md": 1000,
        "/home/user/.claude/plans/plan-2.md": 3000,
        "/home/user/.claude/plans/plan-3.md": 2000,
      };
      return { mtimeMs: mtimes[String(path)] } as any;
    });

    const { findLatestPlanFile } = await import("@/server/plans");
    const result = findLatestPlanFile();

    expect(result).toBe("/home/user/.claude/plans/plan-2.md");
  });

  it("excludes agent plan files", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readdirSync).mockReturnValue(["plan.md", "plan-agent-123.md", "other-agent-plan.md", "latest.md"] as unknown as ReturnType<
      typeof fs.readdirSync
    >);

    vi.mocked(fs.statSync).mockImplementation((path: PathLike) => {
      const mtimes: Record<string, number> = {
        "/home/user/.claude/plans/plan.md": 1000,
        "/home/user/.claude/plans/latest.md": 5000,
      };
      return { mtimeMs: mtimes[String(path)] || 0 } as any;
    });

    const { findLatestPlanFile } = await import("@/server/plans");
    const result = findLatestPlanFile();

    expect(result).toBe("/home/user/.claude/plans/latest.md");
  });
});
