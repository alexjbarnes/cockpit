import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { isAuthDisabled, validateSession } from "@/server/auth";
import { getSessionManager } from "@/server/singleton";

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const repo = body.repo as string;
  const prNumber = body.prNumber as number;
  const prTitle = body.prTitle as string | undefined;

  if (!repo || !prNumber) {
    return NextResponse.json({ error: "repo and prNumber are required" }, { status: 400 });
  }

  const reviewsDir = join(homedir(), ".cockpit", "reviews");
  mkdirSync(reviewsDir, { recursive: true });

  let name = `Review: ${repo}#${prNumber}`;
  if (prTitle) {
    name += ` - ${prTitle}`;
  }
  if (name.length > 80) {
    name = name.slice(0, 77) + "...";
  }

  const session = getSessionManager().createSession(reviewsDir, name);
  return NextResponse.json({ sessionId: session.id, cwd: reviewsDir });
}
