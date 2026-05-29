import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

describe("session-prefs", () => {
  beforeEach(() => {
    vi.resetModules();
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    vi.mocked(mkdirSync).mockReset();
  });

  it("getSessionPrefs returns undefined for unknown session", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const { getSessionPrefs } = await import("@/server/session-prefs");
    expect(getSessionPrefs("unknown")).toBeUndefined();
  });

  it("setSessionPrefs creates and saves", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
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
});
