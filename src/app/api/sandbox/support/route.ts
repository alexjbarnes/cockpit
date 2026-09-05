import { type NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { sandboxSupport } from "@/server/sandbox";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

// Whether the host can enforce the Bash sandbox, so the client can gate its
// toggle instead of offering a sandbox that would silently do nothing.
export function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(sandboxSupport());
}
