import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { addIssueComment, getIssue, saveIssue } from "@/server/issue-storage";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(async ({ key }) => {
    const existing = getIssue(key);
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await req.json();
    if (!body.body || typeof body.body !== "string" || !body.body.trim()) {
      return NextResponse.json({ error: "Comment body is required" }, { status: 400 });
    }

    // UI actions have no MCP token, so they're attributed as the "user"
    // actor kind (types/index.ts's IssueActor) rather than assistant/job/session.
    const updated = addIssueComment(existing, body.body, { kind: "user" });
    try {
      saveIssue(updated);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save comment" }, { status: 400 });
    }

    return NextResponse.json({ issue: updated }, { status: 201 });
  });
}
