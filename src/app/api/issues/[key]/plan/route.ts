import { type NextRequest, NextResponse } from "next/server";
import { readIssuePlan, writeIssuePlan } from "@/server/issue-plan";
import { answer, authenticate } from "./respond";

/** An issue's plan: every version with its review, the markup in progress,
 *  which version is waiting for a decision, and where a decision sends the issue. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { key } = await params;
  return answer(() => readIssuePlan(key));
}

/** A person writes the plan: `{ content }` becomes the next version. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { key } = await params;
  const body = (await req.json().catch(() => null)) as { content?: unknown } | null;
  return answer(() => {
    const written = writeIssuePlan(key, body?.content, { kind: "user" });
    return { ...written, plan: readIssuePlan(key) };
  }, 201);
}
