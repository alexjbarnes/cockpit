import { NextRequest, NextResponse } from "next/server";
import { authenticate, invalidateGhReads, invalidateGhReadsByPrefix, run } from "@/server/gh";

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const {
    repo,
    number,
    action,
    body: reviewBody,
  } = body as {
    repo?: string;
    number?: number;
    action?: string;
    body?: string;
  };

  if (!repo || !number || !action) {
    return NextResponse.json({ error: "repo, number, and action are required" }, { status: 400 });
  }

  const flagMap: Record<string, string> = {
    approve: "--approve",
    "request-changes": "--request-changes",
    comment: "--comment",
  };

  const flag = flagMap[action];
  if (!flag) {
    return NextResponse.json({ error: `Invalid action: ${action}. Must be approve, request-changes, or comment` }, { status: 400 });
  }

  const args = ["pr", "review", String(number), "-R", repo, flag];
  if (reviewBody) {
    args.push("--body", reviewBody);
  }

  try {
    await run(args);
    // The review just changed reviewDecision, so the views that show it are
    // wrong from here: this PR, and every list of the repo's PRs.
    invalidateGhReads(`pr:${repo}:${number}`);
    invalidateGhReadsByPrefix(`prs:${repo}:`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
