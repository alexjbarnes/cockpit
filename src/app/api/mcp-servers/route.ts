import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getClaudeUserConfigFile } from "@/server/paths";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

type TransportType = "stdio" | "http" | "sse";

interface McpServerConfig {
  type?: TransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface McpServerInfo {
  name: string;
  scope: "user" | "project";
  type: TransportType;
  command?: string;
  url?: string;
}

function inferType(config: McpServerConfig): TransportType {
  if (config.type) return config.type;
  if (config.command) return "stdio";
  if (config.url) return "http";
  return "stdio";
}

async function readServersFromFile(filePath: string, scope: "user" | "project"): Promise<McpServerInfo[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const mcpServers = parsed.mcpServers as Record<string, McpServerConfig> | undefined;
  if (!mcpServers || typeof mcpServers !== "object") return [];

  return Object.entries(mcpServers).map(([name, config]) => {
    const type = inferType(config);
    const info: McpServerInfo = { name, scope, type };
    if (type === "stdio" && config.command) info.command = config.command;
    if ((type === "http" || type === "sse") && config.url) info.url = config.url;
    return info;
  });
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");

  const globalFile = getClaudeUserConfigFile();
  const userServers = await readServersFromFile(globalFile, "user");

  let projectServers: McpServerInfo[] = [];
  if (cwd) {
    const projectFile = path.join(cwd, ".mcp.json");
    projectServers = await readServersFromFile(projectFile, "project");
  }

  return NextResponse.json({ servers: [...userServers, ...projectServers] });
}
