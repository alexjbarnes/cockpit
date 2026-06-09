import { describe, expect, it, vi } from "vitest";

const mockStdout = {
  on: vi.fn(),
};
const mockProc = {
  stdout: mockStdout,
  on: vi.fn(),
  kill: vi.fn(),
};
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => mockProc),
}));

import { spawn } from "node:child_process";
import { fetchCliInitData } from "@/server/cli-init-fetch";

describe("fetchCliInitData", () => {
  it("spawns claude with -p --output-format stream-json", async () => {
    mockStdout.on.mockImplementation((event: string, cb: (chunk: Buffer) => void) => {
      if (event !== "data") return;
      const initEvent = JSON.stringify({
        type: "system",
        subtype: "init",
        slash_commands: ["clear", "compact", "review"],
        skills: ["commit", "graphene:init"],
        agents: ["claude", "Explore"],
        claude_code_version: "2.1.141",
        model: "claude-opus-4-7",
        mcp_servers: [{ name: "graphene", status: "connected" }],
      });
      cb(Buffer.from(initEvent + "\n"));
    });

    mockProc.on.mockImplementation((event: string, cb: () => void) => {
      if (event === "close") setTimeout(cb, 50);
    });

    const result = await fetchCliInitData({ cwd: "/tmp" });

    expect(spawn).toHaveBeenCalledWith(
      "claude",
      ["-p", "--no-session-persistence", "--verbose", "--output-format", "stream-json", "hi"],
      expect.objectContaining({ cwd: "/tmp" }),
    );
    expect(result).toEqual({
      slashCommands: ["clear", "compact", "review"],
      skills: ["commit", "graphene:init"],
      agents: [{ name: "claude" }, { name: "Explore" }],
      version: "2.1.141",
      model: "claude-opus-4-7",
      mcpServers: [{ name: "graphene", status: "connected" }],
    });
    expect(mockProc.kill).toHaveBeenCalled();
  });

  it("returns null when process exits without init event", async () => {
    mockStdout.on.mockImplementation(() => {});
    mockProc.on.mockImplementation((event: string, cb: () => void) => {
      if (event === "close") setTimeout(cb, 10);
    });
    mockProc.kill.mockClear();

    const result = await fetchCliInitData({ cwd: "/tmp" });
    expect(result).toBeNull();
  });

  it("skips non-init system events", async () => {
    mockStdout.on.mockImplementation((event: string, cb: (chunk: Buffer) => void) => {
      if (event !== "data") return;
      const hookEvent = JSON.stringify({ type: "system", subtype: "hook_started", hook_event: "SessionStart" });
      const initEvent = JSON.stringify({
        type: "system",
        subtype: "init",
        slash_commands: ["clear"],
        skills: [],
        agents: [],
        claude_code_version: "2.0.0",
        model: "sonnet",
        mcp_servers: [],
      });
      cb(Buffer.from(hookEvent + "\n" + initEvent + "\n"));
    });

    mockProc.on.mockImplementation((event: string, cb: () => void) => {
      if (event === "close") setTimeout(cb, 50);
    });

    const result = await fetchCliInitData({ cwd: "/tmp" });
    expect(result).not.toBeNull();
    expect(result!.slashCommands).toEqual(["clear"]);
  });

  it("uses custom bin path", async () => {
    mockStdout.on.mockImplementation(() => {});
    mockProc.on.mockImplementation((event: string, cb: () => void) => {
      if (event === "close") setTimeout(cb, 10);
    });

    await fetchCliInitData({ cwd: "/tmp", bin: "/usr/local/bin/claude" });
    expect(spawn).toHaveBeenCalledWith("/usr/local/bin/claude", expect.any(Array), expect.any(Object));
  });
});
