import { type NextRequest, NextResponse } from "next/server";
import { saveIssuePlanDraft } from "@/server/issue-plan";
import { answer, authenticate } from "../respond";

/** Save the markup in progress on an issue's plan, or clear it with
 *  `{ draft: null }`. Answers with the draft now stored, which is an older
 *  save's rival when this one lost to it. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { key } = await params;
  const body = (await req.json().catch(() => null)) as { draft?: unknown } | null;
  if (!body || !("draft" in body)) return NextResponse.json({ error: "draft is required" }, { status: 400 });
  if (body.draft === null) return answer(() => ({ draft: saveIssuePlanDraft(key, null) }));
  const draft = body.draft as { version?: unknown; annotations?: unknown; editedText?: unknown; updatedAt?: unknown };
  const version = draft.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return NextResponse.json({ error: "draft.version must be a version number" }, { status: 400 });
  }
  return answer(() => ({
    draft: saveIssuePlanDraft(key, {
      version,
      annotations: Array.isArray(draft.annotations) ? draft.annotations : [],
      editedText: typeof draft.editedText === "string" ? draft.editedText : undefined,
      updatedAt: typeof draft.updatedAt === "number" ? draft.updatedAt : Date.now(),
    }),
  }));
}
