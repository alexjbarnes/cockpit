import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { type PluginScope, setPluginEnabled, uninstallPlugin } from "@/server/plugins";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

const SCOPES = new Set<PluginScope>(["user", "project", "local"]);
function parseScope(value: string | null | undefined): PluginScope | undefined {
  return value && SCOPES.has(value as PluginScope) ? (value as PluginScope) : undefined;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { action?: string; scope?: string };
  const scope = parseScope(body.scope);

  let result: Awaited<ReturnType<typeof setPluginEnabled>>;
  if (body.action === "enable") {
    result = await setPluginEnabled(id, true, scope);
  } else if (body.action === "disable") {
    result = await setPluginEnabled(id, false, scope);
  } else {
    return NextResponse.json({ error: `Unknown action: ${body.action ?? "(none)"}` }, { status: 400 });
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.stderr || "Plugin command failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const scope = parseScope(new URL(req.url).searchParams.get("scope"));
  const result = await uninstallPlugin(id, scope);

  if (!result.ok) {
    return NextResponse.json({ error: result.stderr || "Uninstall failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
