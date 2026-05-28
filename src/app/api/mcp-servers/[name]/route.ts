import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getClaudeUserConfigFile } from "@/server/paths";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

function resolveConfigPath(scope: string, cwd?: string | null): string | null {
  if (scope === "user") {
    return getClaudeUserConfigFile();
  }
  if (scope === "project" && cwd) {
    return path.join(cwd, ".mcp.json");
  }
  return null;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeJsonFile(filePath: string, data: Record<string, unknown>): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await params;
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") || "user";
  const cwd = url.searchParams.get("cwd");

  if (!NAME_RE.test(name)) {
    return NextResponse.json({ error: "Invalid server name" }, { status: 400 });
  }

  const filePath = resolveConfigPath(scope, cwd);
  if (!filePath) {
    return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
  }

  const data = await readJsonFile(filePath);
  const servers = (data.mcpServers || {}) as Record<string, unknown>;
  const config = servers[name];

  if (!config) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  return NextResponse.json({ name, scope, config });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await params;
  const body = await req.json();
  const { scope, cwd, config } = body as {
    scope: string;
    cwd?: string;
    config: Record<string, unknown>;
  };

  if (!NAME_RE.test(name)) {
    return NextResponse.json({ error: "Invalid server name" }, { status: 400 });
  }

  if (!config || typeof config !== "object") {
    return NextResponse.json({ error: "Config is required" }, { status: 400 });
  }

  const filePath = resolveConfigPath(scope, cwd);
  if (!filePath) {
    return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
  }

  const data = await readJsonFile(filePath);
  if (!data.mcpServers) {
    data.mcpServers = {};
  }
  (data.mcpServers as Record<string, unknown>)[name] = config;
  await writeJsonFile(filePath, data);

  return NextResponse.json({ ok: true, name, scope });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await params;
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") || "user";
  const cwd = url.searchParams.get("cwd");

  if (!NAME_RE.test(name)) {
    return NextResponse.json({ error: "Invalid server name" }, { status: 400 });
  }

  const filePath = resolveConfigPath(scope, cwd);
  if (!filePath) {
    return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
  }

  const data = await readJsonFile(filePath);
  const servers = (data.mcpServers || {}) as Record<string, unknown>;

  if (!(name in servers)) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  delete servers[name];
  data.mcpServers = servers;
  await writeJsonFile(filePath, data);

  return NextResponse.json({ ok: true });
}
