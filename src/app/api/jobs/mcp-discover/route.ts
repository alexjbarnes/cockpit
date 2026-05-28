import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getClaudeUserConfigFile } from "@/server/paths";
import { getSessionManager } from "@/server/singleton";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

function readMcpServers(filePath: string): string[] {
  try {
    if (!existsSync(filePath)) return [];
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    return Object.keys(data.mcpServers || data.servers || {});
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cwd = req.nextUrl.searchParams.get("cwd");

  const globalPath = getClaudeUserConfigFile();
  const globalServers = readMcpServers(globalPath);

  const projectServers = cwd ? readMcpServers(join(cwd, ".mcp.json")) : [];

  const runtimeServers = getSessionManager().getKnownMcpServers();

  const all = [...new Set([...globalServers, ...projectServers, ...runtimeServers])];
  return NextResponse.json({ servers: all });
}
