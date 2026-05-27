import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn() };
});

describe("resolveHookBridgePath", () => {
  const origEnv = process.env.COCKPIT_HOOK_BRIDGE_BIN;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.COCKPIT_HOOK_BRIDGE_BIN;
  });

  afterEach(() => {
    if (origEnv) process.env.COCKPIT_HOOK_BRIDGE_BIN = origEnv;
    else delete process.env.COCKPIT_HOOK_BRIDGE_BIN;
  });

  it("returns cwd-based path when bin exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const { resolveHookBridgePath } = await import("@/server/hook-bridge-path");
    const result = resolveHookBridgePath();
    expect(result).toContain("cockpit-hook-bridge.mjs");
  });

  it("uses COCKPIT_HOOK_BRIDGE_BIN override when set and file exists", async () => {
    process.env.COCKPIT_HOOK_BRIDGE_BIN = "/custom/bridge.mjs";
    vi.mocked(existsSync).mockImplementation((p) => p === "/custom/bridge.mjs");
    const { resolveHookBridgePath } = await import("@/server/hook-bridge-path");
    expect(resolveHookBridgePath()).toBe("/custom/bridge.mjs");
  });

  it("falls through override when env var file does not exist", async () => {
    process.env.COCKPIT_HOOK_BRIDGE_BIN = "/missing/bridge.mjs";
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes("bin/cockpit-hook-bridge.mjs"));
    const { resolveHookBridgePath } = await import("@/server/hook-bridge-path");
    expect(resolveHookBridgePath()).toContain("cockpit-hook-bridge.mjs");
  });

  it("throws when no bridge file found", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const { resolveHookBridgePath } = await import("@/server/hook-bridge-path");
    expect(() => resolveHookBridgePath()).toThrow("cockpit-hook-bridge.mjs not found");
  });

  it("caches result on second call", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const { resolveHookBridgePath } = await import("@/server/hook-bridge-path");
    const first = resolveHookBridgePath();
    vi.mocked(existsSync).mockClear();
    const second = resolveHookBridgePath();
    expect(first).toBe(second);
    expect(existsSync).not.toHaveBeenCalled();
  });
});
