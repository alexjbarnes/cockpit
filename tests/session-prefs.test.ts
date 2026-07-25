import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockRenameSync = vi.mocked(renameSync);

describe("session-prefs", () => {
  beforeEach(() => {
    vi.resetModules();
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockRenameSync.mockReset();
    vi.mocked(mkdirSync).mockReset();
  });

  it("getSessionPrefs returns undefined for unknown session", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const { getSessionPrefs } = await import("@/server/session-prefs");
    expect(getSessionPrefs("unknown")).toBeUndefined();
  });

  it("setSessionPrefs creates and saves", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const { setSessionPrefs } = await import("@/server/session-prefs");
    setSessionPrefs("s1", { name: "Test" });

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const data = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(data.s1.name).toBe("Test");
  });

  it("setSessionPrefs merges with existing", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ s1: { name: "Old", planMode: true } }));
    const { setSessionPrefs } = await import("@/server/session-prefs");
    setSessionPrefs("s1", { name: "New" });

    const data = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(data.s1.name).toBe("New");
    expect(data.s1.planMode).toBe(true);
  });

  it("deleteSessionPrefs removes entry", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ s1: { name: "A" }, s2: { name: "B" } }));
    const { deleteSessionPrefs } = await import("@/server/session-prefs");
    deleteSessionPrefs("s1");

    const data = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(data.s1).toBeUndefined();
    expect(data.s2).toBeDefined();
  });

  it("findChainForCliSession returns match when cliSessionId matches directly", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        cockpit1: { cliSessionId: "cli-a", previousCliSessionIds: ["cli-b"] },
      }),
    );
    const { findChainForCliSession } = await import("@/server/session-prefs");
    const result = findChainForCliSession("cli-a");
    expect(result).toEqual({ cockpitId: "cockpit1", truncatedPrevIds: ["cli-b"] });
  });

  it("findChainForCliSession returns match when target is in previousCliSessionIds", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        cockpit1: { cliSessionId: "cli-a", previousCliSessionIds: ["cli-b", "cli-c"] },
      }),
    );
    const { findChainForCliSession } = await import("@/server/session-prefs");
    const result = findChainForCliSession("cli-b");
    expect(result).toEqual({ cockpitId: "cockpit1", truncatedPrevIds: [] });
  });

  it("findChainForCliSession returns null when no match", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        cockpit1: { cliSessionId: "cli-a", previousCliSessionIds: ["cli-b"] },
      }),
    );
    const { findChainForCliSession } = await import("@/server/session-prefs");
    expect(findChainForCliSession("cli-z")).toBeNull();
  });

  it("getSessionPrefs resolves via chain when direct key not found", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        cockpit1: { cliSessionId: "cli-a", previousCliSessionIds: [], model: "opus" },
      }),
    );
    const { getSessionPrefs } = await import("@/server/session-prefs");
    const prefs = getSessionPrefs("cli-a");
    expect(prefs?.model).toBe("opus");
  });

  it("setSessionPrefs writes under cockpit key when cli id resolves to chain", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        cockpit1: { cliSessionId: "cli-a", previousCliSessionIds: [], name: "Old" },
      }),
    );
    const { setSessionPrefs } = await import("@/server/session-prefs");
    setSessionPrefs("cli-a", { model: "opus" });

    const data = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(data.cockpit1.model).toBe("opus");
    expect(data.cockpit1.name).toBe("Old");
    expect(data["cli-a"]).toBeUndefined();
  });

  it("save() writes to a temp path and renames it onto the real prefs file, never writing the real path directly", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const { setSessionPrefs } = await import("@/server/session-prefs");
    setSessionPrefs("s1", { name: "Test" });

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const writtenPath = mockWriteFileSync.mock.calls[0][0] as string;
    expect(writtenPath).not.toBe("session-prefs.json");
    expect(writtenPath).toContain(".tmp-");

    expect(mockRenameSync).toHaveBeenCalledOnce();
    const [from, to] = mockRenameSync.mock.calls[0];
    expect(from).toBe(writtenPath);
    expect(to).not.toContain(".tmp-");
  });

  it("a missing prefs file (ENOENT) starts empty without touching the file at all", async () => {
    const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
    mockReadFileSync.mockImplementation(() => {
      throw enoent;
    });
    const { getSessionPrefs } = await import("@/server/session-prefs");
    expect(getSessionPrefs("s1")).toBeUndefined();
    expect(mockRenameSync).not.toHaveBeenCalled();
  });

  it("a corrupted prefs file starts empty, logs loudly, and preserves the unreadable file instead of silently discarding it", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockReadFileSync.mockReturnValue("{not valid json");
    const { getSessionPrefs, setSessionPrefs } = await import("@/server/session-prefs");

    expect(getSessionPrefs("s1")).toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(mockRenameSync).toHaveBeenCalledOnce();
    const [from, to] = mockRenameSync.mock.calls[0] as [string, string];
    expect(from).not.toContain(".tmp-");
    expect(from).not.toContain(".corrupted-");
    expect(to.startsWith(from)).toBe(true);
    expect(to).toContain(".corrupted-");

    // Confirms the cache is genuinely reset to empty (not left undefined/broken)
    // rather than merely not throwing.
    mockRenameSync.mockClear();
    setSessionPrefs("s2", { name: "New" });
    const data = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(data).toEqual({ s2: { name: "New" } });

    consoleErrorSpy.mockRestore();
  });
});
