import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getTerminalManager } from "@/server/singleton";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const manager = getTerminalManager();
  if (!manager) {
    return NextResponse.json({ error: "Terminal manager not available" }, { status: 503 });
  }

  const body = await req.json();
  const cwd = body.cwd as string;
  if (!cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }

  const terminalId = manager.createTerminal(cwd, body.shell, body.cols, body.rows);
  return NextResponse.json({ terminalId });
}
