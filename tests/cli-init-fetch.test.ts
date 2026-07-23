import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { clearCliInitCache, fetchCliInitData } from "@/server/cli-init-fetch";

describe("fetchCliInitData", () => {
  // Results are cached per cwd, and these cases share one — each needs a
  // genuine spawn to assert against.
  beforeEach(() => {
    clearCliInitCache();
    vi.clearAllMocks();
  });

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

  describe("caching", () => {
    function respondWithInit(commands: string[]): void {
      mockStdout.on.mockImplementation((event: string, cb: (chunk: Buffer) => void) => {
        if (event !== "data") return;
        const initEvent = JSON.stringify({
          type: "system",
          subtype: "init",
          slash_commands: commands,
          skills: [],
          agents: [],
          claude_code_version: "2.0.0",
          model: "sonnet",
          mcp_servers: [],
        });
        cb(Buffer.from(`${initEvent}\n`));
      });
      mockProc.on.mockImplementation((event: string, cb: () => void) => {
        if (event === "close") setTimeout(cb, 10);
      });
    }

    it("spawns once per cwd and serves later calls from cache", async () => {
      respondWithInit(["clear"]);

      const first = await fetchCliInitData({ cwd: "/repo-a" });
      const second = await fetchCliInitData({ cwd: "/repo-a" });

      expect(second).toEqual(first);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("keeps separate entries per cwd", async () => {
      respondWithInit(["clear"]);
      await fetchCliInitData({ cwd: "/repo-a" });
      respondWithInit(["review"]);
      const other = await fetchCliInitData({ cwd: "/repo-b" });

      expect(other?.slashCommands).toEqual(["review"]);
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it("shares one probe between concurrent callers in the same cwd", async () => {
      respondWithInit(["clear"]);

      const [a, b] = await Promise.all([fetchCliInitData({ cwd: "/repo-a" }), fetchCliInitData({ cwd: "/repo-a" })]);

      expect(a).toEqual(b);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("re-probes on force and after the cache is cleared", async () => {
      respondWithInit(["clear"]);
      await fetchCliInitData({ cwd: "/repo-a" });

      await fetchCliInitData({ cwd: "/repo-a", force: true });
      expect(spawn).toHaveBeenCalledTimes(2);

      clearCliInitCache("/repo-a");
      await fetchCliInitData({ cwd: "/repo-a" });
      expect(spawn).toHaveBeenCalledTimes(3);
    });

    it("does not cache a failed probe", async () => {
      mockStdout.on.mockImplementation(() => {});
      mockProc.on.mockImplementation((event: string, cb: () => void) => {
        if (event === "close") setTimeout(cb, 10);
      });

      expect(await fetchCliInitData({ cwd: "/repo-c" })).toBeNull();
      respondWithInit(["clear"]);
      expect((await fetchCliInitData({ cwd: "/repo-c" }))?.slashCommands).toEqual(["clear"]);
      expect(spawn).toHaveBeenCalledTimes(2);
    });
  });
});
