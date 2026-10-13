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
    // `bucket` is what gh offers for "did this pass" (pass, fail, pending,
    // skipping, cancel); the old JSON's `conclusion` and `url` no longer
    // exist, and asking for them made every call fail with a 500.
    const stdout = await runCached(
      `checks:${repo}:${number}`,
      GH_TTL.fast,
      ["pr", "checks", number, "-R", repo, "--json", "name,state,bucket,link,startedAt,completedAt"],
      { bypass: wantsFreshData(req) },
    );
    const checks = JSON.parse(stdout);
    return NextResponse.json(checks);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
