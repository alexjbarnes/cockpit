import { NextRequest, NextResponse } from "next/server";
import { validateSession, isAuthDisabled } from "@/server/auth";
import { getSessionManager } from "@/server/singleton";

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token =
    req.cookies.get("cockpit_session")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

// GET /api/sessions/[id]/mcp - Get MCP server status from initData
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const manager = getSessionManager();
  const initData = manager.getInitData(id);
  return NextResponse.json({ mcpServers: initData?.mcpServers || [] });
}

// POST /api/sessions/[id]/mcp - Toggle or reconnect MCP server
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json();
  const { action, serverName, enabled } = body as {
    action: "toggle" | "reconnect";
    serverName: string;
    enabled?: boolean;
  };

  if (!serverName) {
    return NextResponse.json({ error: "serverName is required" }, { status: 400 });
  }

  const manager = getSessionManager();

  try {
    if (action === "toggle") {
      await manager.mcpToggle(id, serverName, enabled !== false);
    } else if (action === "reconnect") {
      await manager.mcpReconnect(id, serverName);
    } else {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "MCP action failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
