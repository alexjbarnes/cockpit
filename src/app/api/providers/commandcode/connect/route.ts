import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getProvider, syncCommandCodeModels } from "@/server/providers";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

/**
 * Key-only connect for CommandCode: one call stores the key, the model list
 * and the enabled set together.
 *
 * The catalog is public, so this is not a key check — the list comes back
 * whether or not the key is good. A key that is wrong surfaces on the first
 * turn, which is why a failure here answers 502 (the request never arrived)
 * rather than 401 (the provider refused it).
 */
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

  const sync = await syncCommandCodeModels(key.trim());
  if (!sync.ok) return NextResponse.json({ error: sync.error }, { status: sync.rejected ? 401 : 502 });
  return NextResponse.json({ provider: getProvider("commandcode"), sync });
}
