// Host capability detection for the Bash sandbox. The result is cached per
// process, so each case resets modules and re-imports with its own platform and
// set of present binaries.
import { afterEach, describe, expect, it, vi } from "vitest";

const realPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

async function loadWith(platform: NodeJS.Platform, present: string[]) {
  vi.resetModules();
  setPlatform(platform);
  vi.doMock("node:child_process", () => ({
    execFileSync: (_cmd: string, args: string[]) => {
      // which/where <bin>: throw when the binary is not in `present`.
      if (!present.includes(args[0])) throw new Error("not found");
      return Buffer.from("/usr/bin/x");
    },
  }));
  const mod = await import("@/server/sandbox");
  return mod.sandboxSupport();
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe("sandboxSupport", () => {
  it("macOS is supported with nothing to install", async () => {
    const s = await loadWith("darwin", []);
    expect(s).toMatchObject({ supported: true, networkIsolation: true, platform: "darwin" });
  });

  it("Linux with bubblewrap and socat has full support", async () => {
    const s = await loadWith("linux", ["bwrap", "socat"]);
    expect(s).toMatchObject({ supported: true, networkIsolation: true });
  });

  // The CLI disables the sandbox entirely when socat is missing (verified
  // live), so both binaries are required — socat is not merely the network layer.
  it("Linux with bubblewrap but no socat is unsupported and names socat", async () => {
    const s = await loadWith("linux", ["bwrap"]);
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/socat/i);
  });

  it("Linux without bubblewrap is unsupported and names bwrap", async () => {
    const s = await loadWith("linux", []);
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/bwrap/i);
  });

  it("Windows is unsupported", async () => {
    const s = await loadWith("win32", ["bwrap", "socat"]);
    expect(s.supported).toBe(false);
    expect(s.networkIsolation).toBe(false);
  });
});
