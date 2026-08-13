import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("node:os", () => ({ homedir: () => "/home/user" }));
vi.mock("node:path", async () => {
  const actual = await vi.importActual("node:path");
  return { ...actual, join: (...args: string[]) => args.join("/") };
});

describe("defaults", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns fallback when file does not exist", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { getDefaults } = await import("@/server/defaults");
    const defaults = getDefaults();

    expect(defaults).toEqual({
      thinkingLevel: "high",
      bypassAllPermissions: false,
      diffStyle: "split",
      dismissKeyboardOnSend: true,
      thinkingExpanded: false,
      readExpanded: false,
      editExpanded: false,
      toolCallsExpanded: false,
      modelSlots: { main: "sonnet" },
      messageStitching: true,
      reviewsEnabled: true,
      issuesEnabled: false,
      allowSonnet1m: false,
    });
  });

  it("merges file contents with fallback", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        model: "opus",
        thinkingLevel: "low",
      }),
    );

    const { getDefaults } = await import("@/server/defaults");
    const defaults = getDefaults();

    expect(defaults).toEqual({
      thinkingLevel: "low",
      bypassAllPermissions: false,
      diffStyle: "split",
      dismissKeyboardOnSend: true,
      thinkingExpanded: false,
      readExpanded: false,
      editExpanded: false,
      toolCallsExpanded: false,
      modelSlots: { main: "opus" },
      messageStitching: true,
      reviewsEnabled: true,
      issuesEnabled: false,
      allowSonnet1m: false,
    });
  });

  it("migrates legacy model field to modelSlots on read", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ model: "opus" }));

    const { getDefaults } = await import("@/server/defaults");
    const defaults = getDefaults();

    expect(defaults.modelSlots).toEqual({ main: "opus" });
    expect((defaults as unknown as Record<string, unknown>).model).toBeUndefined();
  });

  it("preserves modelSlots when already present", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ modelSlots: { main: "opus", subagent: "haiku" } }));

    const { getDefaults } = await import("@/server/defaults");
    const defaults = getDefaults();

    expect(defaults.modelSlots).toEqual({ main: "opus", subagent: "haiku" });
  });

  it("setDefaults merges partial with current and writes file", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ model: "opus" }));
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => "");

    const { setDefaults } = await import("@/server/defaults");
    const result = setDefaults({ thinkingExpanded: true });

    expect(result.modelSlots).toEqual({ main: "opus" });
    expect(result.thinkingExpanded).toBe(true);
    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it("issuesEnabled defaults to false and round-trips through setDefaults", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => "");

    const { getDefaults, setDefaults } = await import("@/server/defaults");
    expect(getDefaults().issuesEnabled).toBe(false);

    const result = setDefaults({ issuesEnabled: true });
    expect(result.issuesEnabled).toBe(true);
  });

  describe("COCKPIT_ISSUES_ENABLED override", () => {
    afterEach(() => {
      delete process.env.COCKPIT_ISSUES_ENABLED;
    });

    async function readWithStored(stored: Record<string, unknown> | null) {
      const fs = await import("node:fs");
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        if (stored === null) throw new Error("ENOENT");
        return JSON.stringify(stored);
      });
      const { getDefaults } = await import("@/server/defaults");
      return getDefaults();
    }

    it("forces the flag on or off regardless of what is stored", async () => {
      for (const value of ["1", "true"]) {
        process.env.COCKPIT_ISSUES_ENABLED = value;
        expect((await readWithStored({ issuesEnabled: false })).issuesEnabled, value).toBe(true);
        expect((await readWithStored(null)).issuesEnabled, `${value} (no file)`).toBe(true);
      }
      for (const value of ["0", "false"]) {
        process.env.COCKPIT_ISSUES_ENABLED = value;
        expect((await readWithStored({ issuesEnabled: true })).issuesEnabled, value).toBe(false);
      }
    });

    it("leaves the stored value alone when unset or unrecognised", async () => {
      expect((await readWithStored({ issuesEnabled: true })).issuesEnabled).toBe(true);
      process.env.COCKPIT_ISSUES_ENABLED = "yes-please";
      expect((await readWithStored({ issuesEnabled: true })).issuesEnabled).toBe(true);
      expect((await readWithStored({ issuesEnabled: false })).issuesEnabled).toBe(false);
    });

    it("does not write the override back to disk", async () => {
      const fs = await import("node:fs");
      process.env.COCKPIT_ISSUES_ENABLED = "1";
      await readWithStored({ issuesEnabled: false });
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  it("setDefaults handles write failure gracefully", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error("EACCES");
    });

    const { setDefaults } = await import("@/server/defaults");
    const result = setDefaults({ modelSlots: { main: "haiku" } });

    expect(result.modelSlots).toEqual({ main: "haiku" });
  });
});
