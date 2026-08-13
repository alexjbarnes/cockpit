import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getClaudeUserConfigFile } from "@/server/paths";
import { getSessionManager } from "@/server/singleton";

function readMcpServers(filePath: string): string[] {
  try {
    if (!existsSync(filePath)) return [];
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    return Object.keys(data.mcpServers || data.servers || {});
  } catch {
    return [];
  }
}

/** MCP server names a session or job at `cwd` could enable: the user's global
 *  Claude config, the project's .mcp.json, and servers already seen at
 *  runtime. Shared by the /api/jobs/mcp-discover route and the MCP
 *  get_job_options tool so the two menus can't drift. */
export function discoverMcpServerNames(cwd?: string | null): string[] {
  const globalServers = readMcpServers(getClaudeUserConfigFile());
  const projectServers = cwd ? readMcpServers(join(cwd, ".mcp.json")) : [];
  const runtimeServers = getSessionManager().getKnownMcpServers();
  return [...new Set([...globalServers, ...projectServers, ...runtimeServers])];
}
