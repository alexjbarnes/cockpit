import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

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
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    const { getSessionPrefs } = await import("@/server/session-prefs");
    expect(getSessionPrefs("unknown")).toBeUndefined();
  });

  it("setSessionPrefs creates and saves", async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    const { setSessionPrefs } = await import("@/server/session-prefs");
    setSessionPrefs("s1", { name: "Test" });

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const data = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(data["s1"].name).toBe("Test");
  });

  it("setSessionPrefs merges with existing", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ "s1": { name: "Old", planMode: true } }));
    const { setSessionPrefs } = await import("@/server/session-prefs");
    setSessionPrefs("s1", { name: "New" });

    const data = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(data["s1"].name).toBe("New");
    expect(data["s1"].planMode).toBe(true);
  });

  it("deleteSessionPrefs removes entry", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ "s1": { name: "A" }, "s2": { name: "B" } }));
    const { deleteSessionPrefs } = await import("@/server/session-prefs");
    deleteSessionPrefs("s1");

    const data = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(data["s1"]).toBeUndefined();
    expect(data["s2"]).toBeDefined();
  });
});
