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
      permissionMode: "manual",
      sandbox: { enabled: false },
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
      modalPagesEnabled: true,
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
      permissionMode: "manual",
      sandbox: { enabled: false },
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
      modalPagesEnabled: true,
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

  describe("permissionMode, and the bypassAllPermissions boolean it replaces", () => {
    async function readWith(file: Record<string, unknown>) {
      const fs = await import("node:fs");
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(file));
      const { getDefaults } = await import("@/server/defaults");
      return getDefaults() as ReturnType<typeof getDefaults> & Record<string, unknown>;
    }

    it("reads an older file's bypassAllPermissions as the mode it meant", async () => {
      expect((await readWith({ bypassAllPermissions: true })).permissionMode).toBe("bypass");
      vi.resetModules();
      expect((await readWith({ bypassAllPermissions: false })).permissionMode).toBe("manual");
    });

    it("lets a stored mode win over a legacy flag in the same file, and drops the flag", async () => {
      const d = await readWith({ permissionMode: "auto", bypassAllPermissions: true });
      expect(d.permissionMode).toBe("auto");
      expect(d.bypassAllPermissions).toBeUndefined();
    });

    it("reads an unknown stored mode as manual", async () => {
      expect((await readWith({ permissionMode: "yolo" })).permissionMode).toBe("manual");
    });

    it("never writes the legacy key back, so it cannot outlive the next save", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ bypassAllPermissions: true }));
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});
      vi.mocked(fs.mkdirSync).mockImplementation(() => "");

      const { setDefaults } = await import("@/server/defaults");
      setDefaults({ thinkingExpanded: true });

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.permissionMode).toBe("bypass");
      expect(written).not.toHaveProperty("bypassAllPermissions");
    });

    // A browser tab opened before the upgrade still sends the old toggle.
    it("stores a legacy boolean from a client as the mode it meant", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});
      vi.mocked(fs.mkdirSync).mockImplementation(() => "");

      const { setDefaults } = await import("@/server/defaults");
      expect(setDefaults({ bypassAllPermissions: true }).permissionMode).toBe("bypass");
      expect(setDefaults({ bypassAllPermissions: false }).permissionMode).toBe("manual");
      expect(setDefaults({ permissionMode: "auto", bypassAllPermissions: true }).permissionMode).toBe("auto");
    });

    it("refuses to store an unknown mode", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ permissionMode: "auto" }));
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});
      vi.mocked(fs.mkdirSync).mockImplementation(() => "");

      const { setDefaults } = await import("@/server/defaults");
      const result = setDefaults({ permissionMode: "yolo" as never });
      expect(result.permissionMode).toBe("auto");
    });
  });

  describe("sandbox", () => {
    async function readWith(file: Record<string, unknown>) {
      const fs = await import("node:fs");
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(file));
      const { getDefaults } = await import("@/server/defaults");
      return getDefaults();
    }

    it("reads a stored sandbox, keeping only real domains, trimmed", async () => {
      const d = await readWith({ sandbox: { enabled: true, allowedDomains: [" github.com ", "", 7, "*.npmjs.org"] } });
      expect(d.sandbox).toEqual({ enabled: true, allowedDomains: ["github.com", "*.npmjs.org"] });
    });

    it("drops an allowlist that is empty once cleaned, or not a list at all", async () => {
      expect((await readWith({ sandbox: { enabled: true, allowedDomains: ["  "] } })).sandbox).toEqual({ enabled: true });
      vi.resetModules();
      expect((await readWith({ sandbox: { enabled: true, allowedDomains: "github.com" } })).sandbox).toEqual({ enabled: true });
    });

    it("reads a malformed sandbox as off", async () => {
      expect((await readWith({ sandbox: { enabled: "yes" } })).sandbox).toEqual({ enabled: false });
      vi.resetModules();
      expect((await readWith({ sandbox: "on" })).sandbox).toEqual({ enabled: false });
    });

    it("stores a valid sandbox, cleaned, and refuses a malformed one", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ sandbox: { enabled: true, allowedDomains: ["a.com"] } }));
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});
      vi.mocked(fs.mkdirSync).mockImplementation(() => "");

      const { setDefaults } = await import("@/server/defaults");
      expect(setDefaults({ sandbox: { enabled: true, allowedDomains: [" b.com "] } }).sandbox).toEqual({
        enabled: true,
        allowedDomains: ["b.com"],
      });
      expect(setDefaults({ sandbox: { enabled: "yes" } as never }).sandbox).toEqual({ enabled: true, allowedDomains: ["a.com"] });
    });
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
