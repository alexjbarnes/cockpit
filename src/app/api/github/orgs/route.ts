import { NextRequest, NextResponse } from "next/server";
import { authenticate, GH_TTL, runCached, wantsFreshData } from "@/server/gh";

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const bypass = wantsFreshData(req);

  try {
    // Always include the authenticated user's personal account
    const userOut = await runCached("orgs:user", GH_TTL.slow, ["api", "user", "--jq", ".login"], { bypass });
    const username = userOut.trim();

    let orgs: string[] = [];
    try {
      const stdout = await runCached("orgs:user-orgs", GH_TTL.slow, ["api", "user/orgs", "--jq", ".[].login"], { bypass });
      orgs = stdout.trim().split(/\r?\n/).filter(Boolean);
    } catch {
      // read:org scope may be missing, continue with just the personal account
    }

    // Personal account first, then orgs
    const result = [username, ...orgs.filter((o) => o !== username)];
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
