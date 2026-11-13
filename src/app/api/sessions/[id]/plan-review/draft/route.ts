import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { savePlanDraft } from "@/server/plan-review-storage";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/** Save the markup in progress on a session's plan, or clear it with
 *  `{ draft: null }`. Answers with the draft now stored, which is an older
 *  save's rival when this one lost to it. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { draft?: unknown } | null;
  if (!body || !("draft" in body)) {
    return NextResponse.json({ error: "draft is required" }, { status: 400 });
  }
  const subject = { kind: "session" as const, id };
  if (body.draft === null) {
    savePlanDraft(subject, null);
    return NextResponse.json({ draft: null });
  }
  const draft = body.draft as { version?: unknown; annotations?: unknown; editedText?: unknown; updatedAt?: unknown };
  if (typeof draft.version !== "number" || !Number.isInteger(draft.version)) {
    return NextResponse.json({ error: "draft.version must be a version number" }, { status: 400 });
  }
  try {
    const stored = savePlanDraft(subject, {
      version: draft.version,
      annotations: Array.isArray(draft.annotations) ? draft.annotations : [],
      editedText: typeof draft.editedText === "string" ? draft.editedText : undefined,
      updatedAt: typeof draft.updatedAt === "number" ? draft.updatedAt : Date.now(),
    });
    return NextResponse.json({ draft: stored ?? null });
  } catch {
    return NextResponse.json({ error: "Could not save the draft" }, { status: 400 });
  }
}
