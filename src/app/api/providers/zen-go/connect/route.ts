import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getProvider, syncGoModels } from "@/server/providers";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

/** Key-only connect for OpenCode Go: validating the key IS the first model
 *  sync (its /models endpoint is authenticated the same way Zen's is), so one
 *  call stores the key, the model list, and the enabled set together. */
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let key: unknown;
  try {
    ({ key } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (typeof key !== "string" || key.trim() === "") {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }

  const sync = await syncGoModels(key.trim());
  if (!sync.ok) return NextResponse.json({ error: sync.error }, { status: 401 });
  return NextResponse.json({ provider: getProvider("zen-go"), sync });
}
