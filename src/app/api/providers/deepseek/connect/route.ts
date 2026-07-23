import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getProvider, syncDeepSeekModels } from "@/server/providers";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

/** Key-only connect for DeepSeek. The sync validates the key for real: their
 *  authenticated /v1/models endpoint 401s bad keys (unlike zen's open list),
 *  and its response is the list of models the key can actually run. */
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

  const sync = await syncDeepSeekModels(key.trim());
  if (!sync.ok) return NextResponse.json({ error: sync.error }, { status: 401 });
  return NextResponse.json({ provider: getProvider("deepseek"), sync });
}
