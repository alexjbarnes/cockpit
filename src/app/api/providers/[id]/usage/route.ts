import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { DEEPSEEK_PROVIDER_ID, type DeepSeekBalance, getDeepSeekBalance, getProvider, OPENCODE_ZEN_PROVIDER_ID } from "@/server/providers";
import { UsageMeter } from "@/server/usage-meter";

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value;
  return !!token && validateSession(token);
}

/** Usage for built-ins without a spend API. Zen sessions run through the
 *  format proxy, so spend is metered locally; DeepSeek adds the account
 *  balance from their /user/balance endpoint. OpenRouter has its own literal
 *  route (their key API reports spend server-side). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (id !== OPENCODE_ZEN_PROVIDER_ID && id !== DEEPSEEK_PROVIDER_ID) {
    return NextResponse.json({ error: "No usage source for this provider" }, { status: 404 });
  }
  const provider = getProvider(id);
  if (!provider || Object.keys(provider.envVars).length === 0) {
    return NextResponse.json({ error: `${provider?.name ?? id} is not connected` }, { status: 404 });
  }

  // Cost is derived from CURRENT model pricing at read time (the W6 rule:
  // prices are never persisted), so the spend numbers are estimates.
  const pricing = new Map(provider.models.map((m) => [m.modelId, m.pricing]));
  const spend = new UsageMeter().summarize(id, pricing);

  let balance: DeepSeekBalance | null = null;
  let balanceError: string | undefined;
  if (id === DEEPSEEK_PROVIDER_ID) {
    try {
      balance = await getDeepSeekBalance();
    } catch (err) {
      balanceError = err instanceof Error ? err.message : String(err);
    }
  }

  return NextResponse.json({ spend, balance, balanceError });
}
