import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  statSync: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockRenameSync = vi.mocked(renameSync);
const mockStatSync = vi.mocked(statSync);

describe("session-prefs", () => {
  beforeEach(() => {
    vi.resetModules();
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockRenameSync.mockReset();
    mockStatSync.mockReset();
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

  it("reuses the parsed cache while the file is untouched", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ s1: { name: "A" } }));
    mockStatSync.mockReturnValue({ mtimeMs: 111, size: 22 } as never);
    const { getSessionPrefs } = await import("@/server/session-prefs");

    expect(getSessionPrefs("s1")?.name).toBe("A");
    expect(getSessionPrefs("s1")?.name).toBe("A");
    expect(mockReadFileSync).toHaveBeenCalledOnce();
  });

  it("re-reads when the file changed underneath it", async () => {
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({ s1: { name: "A" } }));
    mockStatSync.mockReturnValueOnce({ mtimeMs: 111, size: 22 } as never);
    const { getSessionPrefs } = await import("@/server/session-prefs");
    expect(getSessionPrefs("s1")?.name).toBe("A");

    mockReadFileSync.mockReturnValueOnce(JSON.stringify({ s1: { name: "B" } }));
    mockStatSync.mockReturnValueOnce({ mtimeMs: 222, size: 22 } as never);
    expect(getSessionPrefs("s1")?.name).toBe("B");
  });
});

// The module is compiled into two separate bundles that both load into the one
// server process: dist/src/server/session-prefs.js for the custom server
// (session-manager, ws-handler, transcript) and a Next chunk for the route
// handlers under /api/sessions/[id]/. Each held its own copy of the whole prefs
// map and each save() rewrote the entire file from it, so a tab open (Next side)
// stamped a stale snapshot back over the rename and model change the WS side had
// just made. vi.resetModules() reproduces the two instances exactly.
describe("session-prefs loaded twice in one process", () => {
  let disk: Record<string, { data: string; mtimeMs: number }>;

  beforeEach(() => {
    vi.resetModules();
    disk = {};
    let clock = 0;
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockRenameSync.mockReset();
    mockStatSync.mockReset();
    mockReadFileSync.mockImplementation((p) => {
      const entry = disk[String(p)];
      if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return entry.data;
    });
    mockWriteFileSync.mockImplementation((p, data) => {
      clock += 1;
      disk[String(p)] = { data: String(data), mtimeMs: clock };
    });
    mockRenameSync.mockImplementation((from, to) => {
      disk[String(to)] = disk[String(from)];
      delete disk[String(from)];
    });
    mockStatSync.mockImplementation((p) => {
      const entry = disk[String(p)];
      if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { mtimeMs: entry.mtimeMs, size: entry.data.length } as never;
    });
    vi.mocked(mkdirSync).mockReset();
  });

  function prefsOnDisk(): Record<string, { name?: string; model?: string; activeTabId?: string }> {
    const file = Object.keys(disk).find((f) => !f.includes(".tmp-"));
    return JSON.parse(disk[file!].data);
  }

  it("keeps a write made by the other instance", async () => {
    const custom = await import("@/server/session-prefs");
    custom.setSessionPrefs("s1", { openTabs: [{ type: "file", filePath: "a.ts" }] });

    vi.resetModules();
    const route = await import("@/server/session-prefs");
    route.setSessionPrefs("s1", { name: "renamed by user", model: "opus" });

    custom.setSessionPrefs("s1", { activeTabId: "chat" });

    expect(prefsOnDisk().s1.name).toBe("renamed by user");
    expect(prefsOnDisk().s1.model).toBe("opus");
    expect(prefsOnDisk().s1.activeTabId).toBe("chat");
  });

  it("reads a write made by the other instance", async () => {
    const custom = await import("@/server/session-prefs");
    custom.setSessionPrefs("s1", { name: "before" });

    vi.resetModules();
    const route = await import("@/server/session-prefs");
    route.setSessionPrefs("s1", { name: "renamed by user" });

    expect(custom.getSessionPrefs("s1")?.name).toBe("renamed by user");
  });
});
