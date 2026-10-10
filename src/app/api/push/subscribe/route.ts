import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getNotificationSettings, updateNotificationSettings } from "@/server/notification-settings";
import { getVapidKeys } from "@/server/web-push";
import type { NotificationProviderEntry, WebPushConfig } from "@/types";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/**
 * The half of the VAPID pair the browser needs to subscribe. It is public by
 * design — it is sent with every subscription — so this route only requires a
 * session because everything else does.
 */
export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ publicKey: getVapidKeys().publicKey });
}

interface SubscribeBody {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
  label?: unknown;
}

/**
 * Register a browser's push subscription as a notification provider, so it
 * turns up in the settings list beside Telegram and ntfy with the same enable
 * toggle and filters.
 *
 * The endpoint is the identity: the push service issues it and hands back the
 * same one when the same browser subscribes again, so a repeat is treated as
 * the same device rather than a second entry. Subscribing also re-enables an
 * entry that a dead endpoint switched off, since a fresh subscription means the
 * browser is listening again.
 */
export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: SubscribeBody;
  try {
    body = (await req.json()) as SubscribeBody;
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";
  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: "Missing endpoint or keys" }, { status: 400 });
  }
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 60) : "This device";

  const settings = getNotificationSettings();
  const existing = settings.providers.find((p) => p.type === "webpush" && (p.config as WebPushConfig).endpoint === endpoint);
  const config: WebPushConfig = { endpoint, keys: { p256dh, auth }, label };
  const providers = existing
    ? settings.providers.map((p) => (p.id === existing.id ? { ...p, config, enabled: true } : p))
    : [
        ...settings.providers,
        { id: randomUUID(), type: "webpush", enabled: true, name: label, config } satisfies NotificationProviderEntry,
      ];
  updateNotificationSettings({ providers });

  const entry = providers.find((p) => p.type === "webpush" && (p.config as WebPushConfig).endpoint === endpoint);
  return NextResponse.json({ provider: entry, rejoined: !!existing });
}

/** Forget a subscription, by endpoint. The browser unsubscribes itself at the
 *  same time; this is what removes the entry it left behind. */
export async function DELETE(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { endpoint?: unknown };
  try {
    body = (await req.json()) as { endpoint?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  if (!endpoint) return NextResponse.json({ error: "Missing endpoint" }, { status: 400 });

  const settings = getNotificationSettings();
  const providers = settings.providers.filter((p) => !(p.type === "webpush" && (p.config as WebPushConfig).endpoint === endpoint));
  const removed = providers.length !== settings.providers.length;
  if (removed) updateNotificationSettings({ providers });
  return NextResponse.json({ removed });
}
