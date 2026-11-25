import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { listSessionDirectory, listSessionPaths } from "@/server/session-paths";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }

  try {
    // `dir` present asks for one folder's children (the Files tree, listed as
    // it is expanded); absent asks for the whole tree (the Open File picker).
    const listing = url.searchParams.has("dir")
      ? await listSessionDirectory(cwd, url.searchParams.get("dir") ?? "")
      : await listSessionPaths(cwd);
    return NextResponse.json(listing);
  } catch {
    return NextResponse.json({ error: "Cannot list this folder" }, { status: 400 });
  }
}
