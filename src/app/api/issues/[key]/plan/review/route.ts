import { type NextRequest, NextResponse } from "next/server";
import { reviewIssuePlan } from "@/server/issue-plan";
import { answer, authenticate } from "../respond";

/** A person's decision on the newest version of an issue's plan:
 *  `{ version, action: "approve" | "request_changes", annotations, editedText? }`. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { key } = await params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "A review is required" }, { status: 400 });
  return answer(() =>
    reviewIssuePlan(
      key,
      { version: body.version, action: body.action, annotations: body.annotations, editedText: body.editedText },
      { kind: "user" },
    ),
  );
}
