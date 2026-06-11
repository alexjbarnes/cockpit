import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { coercePluginScope, listPlugins, setPluginEnabled, uninstallPlugin, updatePlugin } from "@/server/plugins";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    const { installed } = await listPlugins();
    const plugin = installed.find((p) => p.id === id);
    if (!plugin) {
      return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    }
    return NextResponse.json(plugin);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { action?: string; scope?: string };
  const scope = coercePluginScope(body.scope);

  if (body.action === "enable" || body.action === "disable") {
    const result = await setPluginEnabled(id, body.action === "enable", scope);
    if (!result.ok) {
      return NextResponse.json({ error: result.stderr || "Plugin command failed" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "update") {
    const result = await updatePlugin(id);
    if (!result.ok) {
      return NextResponse.json({ error: result.stderr || "Update failed" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: `Unknown action: ${body.action ?? "(none)"}` }, { status: 400 });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const scope = coercePluginScope(new URL(req.url).searchParams.get("scope"));
  const result = await uninstallPlugin(id, scope);

  if (!result.ok) {
    return NextResponse.json({ error: result.stderr || "Uninstall failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
