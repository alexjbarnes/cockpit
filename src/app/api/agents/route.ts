import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { isAuthDisabled, validateSession } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

interface AgentInfo {
  name: string;
  scope: "user" | "project";
  description?: string;
  model?: string;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key && val) fields[key] = val;
  }
  return fields;
}

async function readAgentsFromDir(dir: string, scope: "user" | "project"): Promise<AgentInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const agents: AgentInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.replace(/\.md$/, "");
    try {
      const content = await readFile(path.join(dir, entry), "utf-8");
      const fm = parseFrontmatter(content);
      agents.push({
        name,
        scope,
        description: fm.description,
        model: fm.model,
      });
    } catch {
      agents.push({ name, scope });
    }
  }
  return agents;
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");

  const userDir = path.join(homedir(), ".claude", "agents");
  const userAgents = await readAgentsFromDir(userDir, "user");

  let projectAgents: AgentInfo[] = [];
  if (cwd) {
    const projectDir = path.join(cwd, ".claude", "agents");
    projectAgents = await readAgentsFromDir(projectDir, "project");
  }

  return NextResponse.json({ agents: [...userAgents, ...projectAgents] });
}
