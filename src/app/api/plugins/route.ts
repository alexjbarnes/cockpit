import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { listMarketplaces, listPlugins } from "@/server/plugins";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [plugins, marketplaces] = await Promise.all([listPlugins(), listMarketplaces()]);
    return NextResponse.json({ ...plugins, marketplaces });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
