import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getClaudeUserConfigFile } from "@/server/paths";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

interface McpServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function resolveConfigPath(scope: string, cwd?: string | null): string | null {
  if (scope === "user") return getClaudeUserConfigFile();
  if (scope === "project" && cwd) return path.join(cwd, ".mcp.json");
  return null;
}

const INIT_REQUEST = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "cockpit-tools", version: "1.0.0" },
  },
});

const LIST_TOOLS_REQUEST = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
});

const TIMEOUT_MS = 10_000;

async function getStdioTools(config: McpServerConfig): Promise<{ tools: string[]; error?: string }> {
  const command = config.command;
  if (!command) return { tools: [], error: "No command configured" };

  return new Promise((resolve) => {
    let resolved = false;
    let initDone = false;
    let buffer = "";

    const finish = (tools: string[], error?: string) => {
      if (resolved) return;
      resolved = true;
      child.kill();
      resolve({ tools, error });
    };

    const child = spawn(command, config.args || [], {
      env: { ...process.env, ...config.env },
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      if (!resolved) finish([], "Timed out waiting for response");
    }, TIMEOUT_MS);

    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const msg = JSON.parse(trimmed);

          if (!initDone) {
            if (msg.result?.protocolVersion) {
              initDone = true;
              child.stdin.write(LIST_TOOLS_REQUEST + "\n");
            } else if (msg.error) {
              clearTimeout(timeout);
              finish([], `Init error: ${msg.error.message || JSON.stringify(msg.error)}`);
              return;
            }
          } else {
            clearTimeout(timeout);
            if (msg.result?.tools) {
              finish(msg.result.tools.map((t: { name: string }) => t.name));
            } else if (msg.error) {
              finish([], `tools/list error: ${msg.error.message || JSON.stringify(msg.error)}`);
            } else {
              finish([], "Unexpected response from tools/list");
            }
            return;
          }
        } catch {
          // Incomplete JSON line, wait for more data
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line && !resolved) {
        // stderr from stdio MCP servers is often just logging, not fatal
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      finish([], `Failed to start: ${err.message}`);
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (!resolved) {
        finish([], code === 0 ? "Process exited before listing tools" : `Process exited with code ${code}`);
      }
    });

    child.stdin.write(INIT_REQUEST + "\n");
  });
}

function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  for (const line of trimmed.split(/\r?\n/)) {
    const stripped = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (stripped.startsWith("{")) return stripped;
  }
  return null;
}

async function getHttpTools(config: McpServerConfig): Promise<{ tools: string[]; error?: string }> {
  const url = config.url;
  if (!url) return { tools: [], error: "No URL configured" };

  try {
    // Step 1: Initialize
    const initRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...config.headers },
      body: INIT_REQUEST,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const initText = await initRes.text();
    if (!initRes.ok) {
      return { tools: [], error: `HTTP ${initRes.status}: ${initText.slice(0, 200)}` };
    }

    const initJson = extractJson(initText);
    if (!initJson) {
      return { tools: [], error: `No valid JSON in init response: ${initText.slice(0, 200)}` };
    }

    const initParsed = JSON.parse(initJson);
    if (!initParsed.result?.protocolVersion) {
      return { tools: [], error: `Unexpected init response: ${initJson.slice(0, 200)}` };
    }

    // Step 2: List tools
    const toolsRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...config.headers },
      body: LIST_TOOLS_REQUEST,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const toolsText = await toolsRes.text();
    if (!toolsRes.ok) {
      return { tools: [], error: `HTTP ${toolsRes.status} on tools/list: ${toolsText.slice(0, 200)}` };
    }

    const toolsJson = extractJson(toolsText);
    if (!toolsJson) {
      return { tools: [], error: `No valid JSON in tools/list response: ${toolsText.slice(0, 200)}` };
    }

    const toolsParsed = JSON.parse(toolsJson);
    if (toolsParsed.result?.tools) {
      return { tools: toolsParsed.result.tools.map((t: { name: string }) => t.name) };
    }
    if (toolsParsed.error) {
      return { tools: [], error: `tools/list error: ${toolsParsed.error.message || JSON.stringify(toolsParsed.error)}` };
    }
    return { tools: [], error: `Unexpected tools/list response: ${toolsJson.slice(0, 200)}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { tools: [], error: `Connection failed: ${message}` };
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await params;
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") || "user";
  const cwd = url.searchParams.get("cwd");

  const filePath = resolveConfigPath(scope, cwd);
  if (!filePath) {
    return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
  }

  const data = await readJsonFile(filePath);
  const servers = (data.mcpServers || {}) as Record<string, McpServerConfig>;
  const config = servers[name];

  if (!config) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  const type = config.type || (config.command ? "stdio" : "http");
  const result = type === "stdio" ? await getStdioTools(config) : await getHttpTools(config);

  return NextResponse.json(result);
}
