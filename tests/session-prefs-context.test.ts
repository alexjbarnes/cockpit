import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("node:os", () => ({ homedir: () => "/home/user" }));
vi.mock("node:path", async () => {
  const actual = await vi.importActual("node:path");
  return { ...actual, join: (...args: string[]) => args.join("/") };
});

describe("getSessionPrefs context migration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("splits a legacy [1m] suffix into model + contextSize fields", async () => {
    const fs = await import("node:fs");
    const stored = JSON.stringify({
      "sess-1": { model: "claude-opus-4-7[1m]", modelSlots: { main: "claude-opus-4-7[1m]" } },
    });
    vi.mocked(fs.readFileSync).mockReturnValue(stored as never);

    const { getSessionPrefs } = await import("@/server/session-prefs");
    const prefs = getSessionPrefs("sess-1");

    expect(prefs?.model).toBe("claude-opus-4-7");
    expect(prefs?.contextSize).toBe("1m");
    expect(prefs?.modelSlots?.main).toBe("claude-opus-4-7");
    expect(prefs?.modelSlots?.mainContext).toBe("1m");
  });

  it("leaves modern shapes untouched", async () => {
    const fs = await import("node:fs");
    const stored = JSON.stringify({
      "sess-2": { model: "claude-sonnet-4-6", contextSize: "200k", modelSlots: { main: "claude-sonnet-4-6", mainContext: "200k" } },
    });
    vi.mocked(fs.readFileSync).mockReturnValue(stored as never);

    const { getSessionPrefs } = await import("@/server/session-prefs");
    const prefs = getSessionPrefs("sess-2");

    expect(prefs?.model).toBe("claude-sonnet-4-6");
    expect(prefs?.contextSize).toBe("200k");
    expect(prefs?.modelSlots?.main).toBe("claude-sonnet-4-6");
    expect(prefs?.modelSlots?.mainContext).toBe("200k");
  });
});
