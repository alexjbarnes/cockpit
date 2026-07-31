import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { applyIssueUpdate, getIssue, saveIssue } from "@/server/issue-storage";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export function GET(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(({ key }) => {
    const issue = getIssue(key);
    if (!issue) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ issue });
  });
}

export function PUT(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(async ({ key }) => {
    const existing = getIssue(key);
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await req.json();
    try {
      // UI actions have no MCP token, so they're attributed as the "user"
      // actor kind (types/index.ts's IssueActor) rather than
      // assistant/job/session. applyIssueUpdate now validates its own patch
      // (status/priority/labels/title/description) and throws on a bad
      // value, so it has to be inside this try too, not just saveIssue —
      // otherwise a bad value would 500 instead of 400.
      const updated = applyIssueUpdate(existing, body, { kind: "user" });
      saveIssue(updated);
      return NextResponse.json({ issue: updated });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save issue" }, { status: 400 });
    }
  });
}
