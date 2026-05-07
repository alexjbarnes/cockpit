import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { globalSearch } from "@/server/transcript";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const q = req.nextUrl.searchParams.get("q") || "";
  if (q.length < 2) {
    return NextResponse.json({ error: "Query must be at least 2 characters" }, { status: 400 });
  }

  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 50, 100);
  const offset = Math.max(Number(req.nextUrl.searchParams.get("offset")) || 0, 0);
  const { results, totalFilesSearched, truncated } = await globalSearch(q, limit, offset);

  return NextResponse.json({ results, totalFilesSearched, truncated });
}
