import { NextRequest, NextResponse } from "next/server";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { validateToken } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token =
    req.cookies.get("cockpit_token")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateToken(token);
}

interface CommandInfo {
  name: string;
  scope: "user" | "project";
  description?: string;
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

async function readCommandsFromDir(dir: string, scope: "user" | "project"): Promise<CommandInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const commands: CommandInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.replace(/\.md$/, "");
    try {
      const content = await readFile(path.join(dir, entry), "utf-8");
      const fm = parseFrontmatter(content);
      commands.push({
        name,
        scope,
        description: fm.description,
      });
    } catch {
      commands.push({ name, scope });
    }
  }
  return commands;
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");

  const userDir = path.join(homedir(), ".claude", "commands");
  const userCommands = await readCommandsFromDir(userDir, "user");

  let projectCommands: CommandInfo[] = [];
  if (cwd) {
    const projectDir = path.join(cwd, ".claude", "commands");
    projectCommands = await readCommandsFromDir(projectDir, "project");
  }

  return NextResponse.json({ commands: [...userCommands, ...projectCommands] });
}
