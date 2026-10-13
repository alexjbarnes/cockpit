import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getProvider, syncGroqModels } from "@/server/providers";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

/**
 * Key-only connect for Groq: one call stores the key, the model list and the
 * enabled set together. Unlike Zen's public list, Groq's /models is
 * authenticated and answers 401 for a bad key, so a refusal here really is the
 * key (rejected), while anything else is the request not getting an answer.
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

  const sync = await syncGroqModels(key.trim());
  // 401 only for a key the provider actually refused; a request that never got
  // an answer is not the key's fault. OpenRouter's route draws the same line.
  if (!sync.ok) return NextResponse.json({ error: sync.error }, { status: sync.rejected ? 401 : 502 });
  return NextResponse.json({ provider: getProvider("groq"), sync });
}
