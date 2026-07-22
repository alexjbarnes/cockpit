import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { OPENROUTER_PROVIDER_ID, openRouterBaseUrl, syncOpenRouterCatalog } from "@/server/provider-catalog";
import { updateProvider } from "@/server/providers";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

/** Key-only connect: validate the key against OpenRouter, persist it, then
 *  run an immediate catalog sync so the provider is usable straight away. */
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

  try {
    const res = await fetch(`${openRouterBaseUrl()}/v1/key`, {
      headers: { Authorization: `Bearer ${key.trim()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `OpenRouter rejected the key (HTTP ${res.status})` }, { status: 401 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Could not validate key: ${message}` }, { status: 502 });
  }

  const provider = updateProvider(OPENROUTER_PROVIDER_ID, { envVars: { ANTHROPIC_AUTH_TOKEN: key.trim() } });
  const sync = await syncOpenRouterCatalog();
  return NextResponse.json({ provider, sync });
}
