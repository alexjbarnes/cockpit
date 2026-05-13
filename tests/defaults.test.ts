import { beforeEach, describe, expect, it, vi } from "vitest";

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
