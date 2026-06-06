import { NextRequest, NextResponse } from "next/server";
import type { ContextSize } from "@/lib/models";
import { type AssistantSettings, getAssistantSettings, updateAssistantSettings } from "@/server/assistant-settings";
import { validateSession } from "@/server/auth";
import { getSessionManager } from "@/server/singleton";
import type { ThinkingLevel } from "@/types";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const settings = getAssistantSettings();
  return NextResponse.json(settings);
}

export async function PATCH(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json();
  // Only the settings-page fields are accepted from the client. sessionId is
  // server-managed (written by the resolver); a PATCH body must never overwrite it.
  const partial: Partial<AssistantSettings> = {};
  if (typeof body.model === "string" && body.model) partial.model = body.model;
  if (typeof body.thinkingLevel === "string" && body.thinkingLevel) {
    partial.thinkingLevel = body.thinkingLevel as ThinkingLevel;
  }
  if (body.runtime === "stream" || body.runtime === "pty") partial.runtime = body.runtime;
  if (body.contextSize === "200k" || body.contextSize === "1m") partial.contextSize = body.contextSize as ContextSize;
  const updated = updateAssistantSettings(partial);
  await getSessionManager().applyCockpitAgentSettings({
    model: partial.model,
    thinkingLevel: partial.thinkingLevel,
    contextSize: partial.contextSize,
  });
  return NextResponse.json(updated);
}
