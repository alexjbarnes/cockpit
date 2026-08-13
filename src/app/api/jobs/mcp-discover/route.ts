import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { discoverMcpServerNames } from "@/server/mcp-discovery";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ servers: discoverMcpServerNames(req.nextUrl.searchParams.get("cwd")) });
}
