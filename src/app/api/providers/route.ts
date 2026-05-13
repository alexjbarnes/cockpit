import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { addProvider, getProviders } from "@/server/providers";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

export function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(getProviders());
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!body.name || !body.models) {
    return NextResponse.json({ error: "name and models are required" }, { status: 400 });
  }
  const provider = addProvider({
    name: body.name,
    envVars: body.envVars || {},
    models: body.models || [],
  });
  return NextResponse.json(provider, { status: 201 });
}
