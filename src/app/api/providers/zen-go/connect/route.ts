import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getProvider, syncGoModels } from "@/server/providers";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

/**
 * Key-only connect for OpenCode Go: one call stores the key, the model list and
 * the enabled set together.
 *
 * The key is NOT validated here, and cannot be: /models is a public list that
 * answers 200 whatever the Authorization header says (measured: empty, junk,
 * 4KB and control-character values all pass). So a failure below is the request
 * never reaching opencode.ai, not a bad key, which is why it answers 502 rather
 * than 401. A key that is wrong shows up on the first turn.
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

  const sync = await syncGoModels(key.trim());
  // 401 only for a key the provider actually refused; a request that never
  // got an answer is not the key's fault, and saying so sends the user off
  // to re-paste a key that was fine. OpenRouter's route draws the same line.
  if (!sync.ok) return NextResponse.json({ error: sync.error }, { status: sync.rejected ? 401 : 502 });
  return NextResponse.json({ provider: getProvider("zen-go"), sync });
}
