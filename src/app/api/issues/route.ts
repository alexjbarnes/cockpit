import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { buildIssue, loadIssues, loadProjects, saveIssue } from "@/server/issue-storage";
import type { IssueStatus } from "@/types";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const projectId = req.nextUrl.searchParams.get("project");
  const status = req.nextUrl.searchParams.get("status") as IssueStatus | null;

  // loadIssues is sharded per project (issue-storage.ts), so listing "all
  // issues" means reading every project's shard. A `project` filter skips
  // that and reads just the one shard.
  const issues = projectId ? loadIssues(projectId) : loadProjects().flatMap((p) => loadIssues(p.id));
  const filtered = status ? issues.filter((issue) => issue.status === status) : issues;

  return NextResponse.json({ issues: filtered });
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  if (!body.projectId || !body.title) {
    return NextResponse.json({ error: "projectId and title are required" }, { status: 400 });
  }

  try {
    // Shared with the MCP create_issue tool so the two paths cannot drift
    // (the create_job lesson — see issue-storage.ts). buildIssue takes no
    // `key`, so a caller cannot construct a colliding key even by accident.
    const issue = buildIssue(body, { kind: "user" });
    saveIssue(issue);
    return NextResponse.json({ issue }, { status: 201 });
  } catch (err) {
    // buildIssue throws "Unknown project" for a bad projectId before an
    // Issue is even constructed; saveIssue can also throw on a key collision.
    // Either way: a usable message, not a bare 500.
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to create issue" }, { status: 400 });
  }
}
