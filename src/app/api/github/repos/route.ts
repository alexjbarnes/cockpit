import { NextRequest, NextResponse } from "next/server";
import { authenticate, GH_TTL, run, runCached, wantsFreshData } from "@/server/gh";

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check gh auth status first. Not cached on purpose: it is the gate that
  // decides whether the cached answer below is still about a signed-in user.
  try {
    await run(["auth", "status"]);
  } catch {
    return NextResponse.json({ error: "GitHub CLI not authenticated. Run 'gh auth login' first." }, { status: 401 });
  }

  const url = new URL(req.url);
  const owner = url.searchParams.get("owner");

  try {
    const args = ["repo", "list"];
    if (owner) args.push(owner);
    args.push("--json", "name,nameWithOwner,description,primaryLanguage,pushedAt,isPrivate", "--limit", "100", "--no-archived");

    const stdout = await runCached(`repos:${owner ?? "all"}`, GH_TTL.slow, args, { bypass: wantsFreshData(req) });
    const repos = JSON.parse(stdout);
    return NextResponse.json(repos);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
