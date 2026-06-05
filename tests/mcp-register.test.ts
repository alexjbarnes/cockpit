import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("@/server/paths", () => ({
  getClaudeUserConfigFile: () => "/home/user/.claude.json",
  getCockpitConfigServerPath: () => "/home/user/cockpit/dist/server/mcp/cockpit-config-server.js",
  getCockpitDir: () => "/home/user/.cockpit",
}));

describe("mcp-register", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("ensures cockpit-config entry is added when missing", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ mcpServers: {} }));
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});

    const { ensureCockpitConfigServer } = await import("@/server/mcp/register");
    ensureCockpitConfigServer();

    expect(fs.writeFileSync).toHaveBeenCalledWith("/home/user/.claude.json", expect.stringContaining("cockpit-config"));
    const written = JSON.parse((vi.mocked(fs.writeFileSync).mock.calls[0][1] as string).trim());
    expect(written.mcpServers["cockpit-config"]).toEqual({
      command: "node",
      args: ["/home/user/cockpit/dist/server/mcp/cockpit-config-server.js"],
      env: { COCKPIT_CONFIG_DIR: "/home/user/.cockpit" },
    });
  });

  it("returns early when compiled server file is missing", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ mcpServers: {} }));

    const { ensureCockpitConfigServer } = await import("@/server/mcp/register");
    ensureCockpitConfigServer();

    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("creates mcpServers object when file is empty", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});

    const { ensureCockpitConfigServer } = await import("@/server/mcp/register");
    ensureCockpitConfigServer();

    const written = JSON.parse((vi.mocked(fs.writeFileSync).mock.calls[0][1] as string).trim());
    expect(written.mcpServers["cockpit-config"]).toBeDefined();
  });

  it("is no-op when entry already exists with correct args", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        mcpServers: {
          "cockpit-config": {
            command: "node",
            args: ["/home/user/cockpit/dist/server/mcp/cockpit-config-server.js"],
            env: { COCKPIT_CONFIG_DIR: "/home/user/.cockpit" },
          },
        },
      }),
    );

    const { ensureCockpitConfigServer } = await import("@/server/mcp/register");
    ensureCockpitConfigServer();

    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("preserves extra env vars when updating args", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        mcpServers: {
          "cockpit-config": {
            command: "node",
            args: ["/old/path/cockpit-config-server.js"],
            env: { COCKPIT_CONFIG_DIR: "/home/user/.cockpit", EXTRA_VAR: "keep" },
          },
        },
      }),
    );
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});

    const { ensureCockpitConfigServer } = await import("@/server/mcp/register");
    ensureCockpitConfigServer();

    const written = JSON.parse((vi.mocked(fs.writeFileSync).mock.calls[0][1] as string).trim());
    expect(written.mcpServers["cockpit-config"].args[0]).toBe("/home/user/cockpit/dist/server/mcp/cockpit-config-server.js");
    expect(written.mcpServers["cockpit-config"].env.EXTRA_VAR).toBe("keep");
  });
});
