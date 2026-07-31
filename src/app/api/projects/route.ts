import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { buildProject, loadProjects, saveProject } from "@/server/issue-storage";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({ projects: loadProjects() });
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  if (!body.name || !body.prefix) {
    return NextResponse.json({ error: "name and prefix are required" }, { status: 400 });
  }

  try {
    // Shared with the MCP project tools so the two paths cannot drift (the
    // create_job lesson — see issue-storage.ts). buildProject now validates
    // name/prefix/description/repoPath/archived and throws on a bad value
    // (e.g. a non-string prefix, which used to 500 via normalizePrefix's
    // `.trim()` rather than a clean 400), so it has to be inside this try
    // too, not just saveProject.
    const project = buildProject(body);
    saveProject(project);
    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save project" }, { status: 400 });
  }
}
