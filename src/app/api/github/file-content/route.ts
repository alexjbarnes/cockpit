import { NextRequest, NextResponse } from "next/server";
import { authenticate, GH_TTL, runCached, wantsFreshData } from "@/server/gh";

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const repo = url.searchParams.get("repo");
  const path = url.searchParams.get("path");
  const ref = url.searchParams.get("ref");

  if (!repo || !path || !ref) {
    return NextResponse.json({ error: "repo, path, and ref are required" }, { status: 400 });
  }

  try {
    // The ref is a commit in every path the diff viewer takes, so the answer
    // is a fact about that commit; a branch name would just age out.
    const content = await runCached(
      `file:${repo}:${ref}:${path}`,
      GH_TTL.slow,
      ["api", `repos/${repo}/contents/${path}?ref=${ref}`, "--jq", ".content"],
      { bypass: wantsFreshData(req) },
    );
    const decoded = Buffer.from(content.trim(), "base64").toString("utf-8");
    return NextResponse.json({ content: decoded });
  } catch {
    // File may not exist at this ref (new file or deleted file). A miss is not
    // cached, so the next look tries again.
    return NextResponse.json({ content: null });
  }
}
