import { NextRequest, NextResponse } from "next/server";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { validateToken } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token =
    req.cookies.get("aperture_token")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateToken(token);
}

interface SkillInfo {
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

async function readSkillsFromDir(dir: string, scope: "user" | "project"): Promise<SkillInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    const skillDir = path.join(dir, entry);
    try {
      const s = await stat(skillDir);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    const skillFile = path.join(skillDir, "SKILL.md");
    try {
      const content = await readFile(skillFile, "utf-8");
      const fm = parseFrontmatter(content);
      skills.push({
        name: fm.name || entry,
        scope,
        description: fm.description,
      });
    } catch {
      // Directory exists but no SKILL.md -- skip
    }
  }
  return skills;
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");

  const userDir = path.join(homedir(), ".claude", "skills");
  const userSkills = await readSkillsFromDir(userDir, "user");

  let projectSkills: SkillInfo[] = [];
  if (cwd) {
    const projectDir = path.join(cwd, ".claude", "skills");
    projectSkills = await readSkillsFromDir(projectDir, "project");
  }

  return NextResponse.json({ skills: [...userSkills, ...projectSkills] });
}
