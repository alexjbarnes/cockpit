import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("node:os", () => ({ homedir: () => "/home/user" }));
vi.mock("@/server/paths", () => ({
  getCockpitDir: () => "/home/user/.cockpit",
}));

describe("assistant-settings", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns defaults when file does not exist", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { getAssistantSettings } = await import("@/server/assistant-settings");
    const settings = getAssistantSettings();

    expect(settings).toEqual({
      model: "sonnet",
      thinkingLevel: "high",
    });
  });

  it("merges file contents with defaults", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ model: "opus" }));

    const { getAssistantSettings } = await import("@/server/assistant-settings");
    const settings = getAssistantSettings();

    expect(settings).toEqual({
      model: "opus",
      thinkingLevel: "high",
    });
  });

  it("updateAssistantSettings persists and returns merged result", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ model: "sonnet", thinkingLevel: "high" }));
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => "");

    const { updateAssistantSettings } = await import("@/server/assistant-settings");
    const result = updateAssistantSettings({ thinkingLevel: "low" });

    expect(result).toEqual({ model: "sonnet", thinkingLevel: "low" });
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining("assistant.json"), expect.stringContaining("low"));
  });

  it("updateAssistantSettings handles write failure gracefully", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error("EACCES");
    });

    const { updateAssistantSettings } = await import("@/server/assistant-settings");
    const result = updateAssistantSettings({ model: "haiku" });

    expect(result.model).toBe("haiku");
  });
});
