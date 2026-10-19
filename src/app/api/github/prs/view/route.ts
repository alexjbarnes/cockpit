import { NextRequest, NextResponse } from "next/server";
import { authenticate, GH_TTL, runCached, wantsFreshData } from "@/server/gh";

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const repo = url.searchParams.get("repo");
  const number = url.searchParams.get("number");

  if (!repo || !number) {
    return NextResponse.json({ error: "repo and number are required" }, { status: 400 });
  }

  try {
    const stdout = await runCached(
      `pr:${repo}:${number}`,
      GH_TTL.medium,
      [
        "pr",
        "view",
        number,
        "-R",
        repo,
        "--json",
        "title,body,author,number,additions,deletions,files,changedFiles,headRefName,baseRefName,headRefOid,baseRefOid,state,isDraft,labels,reviewDecision,createdAt,updatedAt,url",
      ],
      { bypass: wantsFreshData(req) },
    );
    const pr = JSON.parse(stdout);

    if (pr.baseRefOid && pr.headRefOid) {
      try {
        // Keyed by the two commits, so it is a fact about those commits rather
        // than about the PR: a push gets a new key, and the old answer stands.
        const mergeBaseOut = await runCached(`mergebase:${repo}:${pr.baseRefOid}...${pr.headRefOid}`, GH_TTL.slow, [
          "api",
          `repos/${repo}/compare/${pr.baseRefOid}...${pr.headRefOid}`,
          "--jq",
          ".merge_base_commit.sha",
        ]);
        pr.mergeBaseSha = mergeBaseOut.trim();
      } catch {
        pr.mergeBaseSha = pr.baseRefOid;
      }
    }

    return NextResponse.json(pr);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
