import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factories below can reference them and they survive
// vi.resetModules() (which we use to reset claude-bin's module-level cache).
const { mockExecFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFileSync: mockExecFileSync }));
vi.mock("node:fs", () => ({ existsSync: mockExistsSync }));

async function loadGetClaudeBin() {
  vi.resetModules();
  return (await import("@/server/claude-bin")).getClaudeBin;
}

describe("getClaudeBin", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockExistsSync.mockReset();
  });

  it("resolves via which once and serves the cached path while it still exists", async () => {
    mockExecFileSync.mockReturnValue("/usr/local/bin/claude\n");
    mockExistsSync.mockReturnValue(true);
    const getClaudeBin = await loadGetClaudeBin();

    expect(getClaudeBin()).toBe("/usr/local/bin/claude");
    expect(getClaudeBin()).toBe("/usr/local/bin/claude");
    // Resolved exactly once; the second call is served from the validated cache.
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("re-resolves when the cached absolute binary was deleted (claude self-update)", async () => {
    mockExecFileSync
      .mockReturnValueOnce("/home/u/.local/share/claude/versions/2.1.170\n")
      .mockReturnValueOnce("/home/u/.local/bin/claude\n");
    // The first cached path is gone by the time it is re-validated on the 2nd call.
    mockExistsSync.mockReturnValueOnce(false);
    const getClaudeBin = await loadGetClaudeBin();

    expect(getClaudeBin()).toBe("/home/u/.local/share/claude/versions/2.1.170");
    // Cached binary vanished under the long-running server -> re-resolve, don't wedge.
    expect(getClaudeBin()).toBe("/home/u/.local/bin/claude");
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it("caches the bare-name PATH fallback and does not re-run which or stat it", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("which: claude: not found");
    });
    const getClaudeBin = await loadGetClaudeBin();

    expect(getClaudeBin()).toBe("claude");
    expect(getClaudeBin()).toBe("claude");
    // "claude" is relative: not existsSync-validated, stays cached after one resolve.
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExistsSync).not.toHaveBeenCalled();
  });
});
