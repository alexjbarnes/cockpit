import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { cancelLogin, listClaudeMcpServers, logoutMcpServer, startMcpLogin, submitLoginRedirect } from "@/server/mcp-auth";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") ?? undefined;
  const force = url.searchParams.get("refresh") === "1";

  try {
    const list = await listClaudeMcpServers({ cwd, force });
    return NextResponse.json(list);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    name?: string;
    id?: string;
    redirectUrl?: string;
    cwd?: string;
  };

  if (body.action === "login") {
    if (!body.name) {
      return NextResponse.json({ error: "Missing server name" }, { status: 400 });
    }
    const outcome = await startMcpLogin(body.name, body.cwd);
    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.error }, { status: 502 });
    }
    return NextResponse.json(outcome);
  }

  if (body.action === "submit") {
    if (!body.id || !body.redirectUrl) {
      return NextResponse.json({ error: "Missing sign-in id or redirect URL" }, { status: 400 });
    }
    const result = await submitLoginRedirect(body.id, body.redirectUrl.trim());
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "logout") {
    if (!body.name) {
      return NextResponse.json({ error: "Missing server name" }, { status: 400 });
    }
    const result = await logoutMcpServer(body.name, body.cwd);
    if (!result.ok) {
      return NextResponse.json({ error: result.stderr || "Sign out failed" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: `Unknown action: ${body.action ?? "(none)"}` }, { status: 400 });
}

export async function DELETE(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing sign-in id" }, { status: 400 });
  }
  return NextResponse.json({ ok: cancelLogin(id) });
}
