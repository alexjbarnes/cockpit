import { type NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { parseSandboxRules, readSandboxRules, SandboxRulesError, writeSandboxRules } from "@/server/claude-sandbox-rules";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

function errorResponse(err: unknown) {
  if (err instanceof SandboxRulesError) return NextResponse.json({ error: err.message }, { status: err.status });
  return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
}

// The shared Bash sandbox rules in the user's ~/.claude/settings.json. Running
// sessions pick an edit up from the file itself, so saving needs no restart.
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await readSandboxRules());
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  const baseVersion = (body as { baseVersion?: unknown } | null)?.baseVersion;
  try {
    return NextResponse.json(await writeSandboxRules(parseSandboxRules(body), typeof baseVersion === "string" ? baseVersion : undefined));
  } catch (err) {
    return errorResponse(err);
  }
}
