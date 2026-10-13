import { NextRequest, NextResponse } from "next/server";
import { authenticate, GH_TTL, runCached, wantsFreshData } from "@/server/gh";

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const repo = url.searchParams.get("repo");
  const state = url.searchParams.get("state") || "open";

  if (!repo) {
    return NextResponse.json({ error: "repo is required" }, { status: 400 });
  }

  try {
    const stdout = await runCached(
      `prs:${repo}:${state}`,
      GH_TTL.fast,
      [
        "pr",
        "list",
        "-R",
        repo,
        "--state",
        state,
        "--json",
        "number,title,author,additions,deletions,changedFiles,createdAt,updatedAt,headRefName,baseRefName,isDraft,labels,reviewDecision,state",
        "--limit",
        "50",
      ],
      { bypass: wantsFreshData(req) },
    );
    const prs = JSON.parse(stdout);
    return NextResponse.json(prs);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
