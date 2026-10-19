import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getProvider, syncGeminiModels } from "@/server/providers";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

/**
 * Key-only connect for Google AI Studio's OpenAI compatibility layer: one call
 * stores the key, the model list and the enabled set together. Its model list
 * is authenticated, so a refusal there is the key (rejected) and anything else
 * is a request that never got an answer.
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

  const sync = await syncGeminiModels(key.trim());
  if (!sync.ok) return NextResponse.json({ error: sync.error }, { status: sync.rejected ? 401 : 502 });
  return NextResponse.json({ provider: getProvider("gemini"), sync });
}
