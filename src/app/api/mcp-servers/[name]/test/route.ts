import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";

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
  if (scope === "user") return path.join(homedir(), ".claude.json");
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
    clientInfo: { name: "cockpit-test", version: "1.0.0" },
  },
});

const TIMEOUT_MS = 10_000;

async function testStdio(config: McpServerConfig): Promise<{ success: boolean; logs: string }> {
  const command = config.command;
  if (!command) return { success: false, logs: "No command configured" };

  return new Promise((resolve) => {
    const logs: string[] = [];
    let resolved = false;

    const finish = (success: boolean) => {
      if (resolved) return;
      resolved = true;
      child.kill();
      resolve({ success, logs: logs.join("\n") });
    };

    const child = spawn(command, config.args || [], {
      env: { ...process.env, ...config.env },
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      logs.push("Timed out waiting for response");
      finish(false);
    }, TIMEOUT_MS);

    let stdout = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      try {
        const parsed = JSON.parse(stdout);
        clearTimeout(timeout);
        if (parsed.result?.protocolVersion) {
          const name = parsed.result.serverInfo?.name || "unknown";
          const version = parsed.result.serverInfo?.version || "";
          logs.push(`Connected: ${name} ${version}`.trim());
          logs.push(`Protocol: ${parsed.result.protocolVersion}`);
          if (parsed.result.capabilities) {
            const caps = Object.keys(parsed.result.capabilities);
            if (caps.length > 0) logs.push(`Capabilities: ${caps.join(", ")}`);
          }
          finish(true);
        } else if (parsed.error) {
          logs.push(`Error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
          finish(false);
        } else {
          logs.push(`Unexpected response: ${stdout.slice(0, 500)}`);
          finish(false);
        }
      } catch {
        // Incomplete JSON, wait for more data
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) logs.push(line);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      logs.push(`Failed to start: ${err.message}`);
      finish(false);
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (!resolved) {
        logs.push(`Process exited with code ${code}`);
        finish(false);
      }
    });

    child.stdin.write(INIT_REQUEST + "\n");
  });
}

function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  for (const line of trimmed.split("\n")) {
    const stripped = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (stripped.startsWith("{")) return stripped;
  }
  return null;
}

async function testHttp(config: McpServerConfig): Promise<{ success: boolean; logs: string }> {
  const url = config.url;
  if (!url) return { success: false, logs: "No URL configured" };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...config.headers,
      },
      body: INIT_REQUEST,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const text = await res.text();
    if (!res.ok) {
      return { success: false, logs: `HTTP ${res.status}: ${text.slice(0, 500)}` };
    }

    const json = extractJson(text);
    if (!json) {
      return { success: false, logs: `No valid JSON in response: ${text.slice(0, 500)}` };
    }

    try {
      const parsed = JSON.parse(json);
      if (parsed.result?.protocolVersion) {
        const sName = parsed.result.serverInfo?.name || "unknown";
        const sVersion = parsed.result.serverInfo?.version || "";
        const logs = [`Connected: ${sName} ${sVersion}`.trim(), `Protocol: ${parsed.result.protocolVersion}`];
        if (parsed.result.capabilities) {
          const caps = Object.keys(parsed.result.capabilities);
          if (caps.length > 0) logs.push(`Capabilities: ${caps.join(", ")}`);
        }
        return { success: true, logs: logs.join("\n") };
      }
      return { success: false, logs: `Unexpected response: ${json.slice(0, 500)}` };
    } catch {
      return { success: false, logs: `Invalid JSON: ${json.slice(0, 500)}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, logs: `Connection failed: ${message}` };
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
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
  const result = type === "stdio" ? await testStdio(config) : await testHttp(config);

  return NextResponse.json(result);
}
