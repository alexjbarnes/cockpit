import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getClaudeDir } from "@/server/paths";
import { readSkillsFromDir, type SkillInfo } from "@/server/skills";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");

  const userDir = path.join(getClaudeDir(), "skills");
  const userSkills = await readSkillsFromDir(userDir, "user");

  let projectSkills: SkillInfo[] = [];
  if (cwd) {
    const projectDir = path.join(cwd, ".claude", "skills");
    projectSkills = await readSkillsFromDir(projectDir, "project");
  }

  return NextResponse.json({ skills: [...userSkills, ...projectSkills] });
}
