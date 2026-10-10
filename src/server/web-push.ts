import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import { debugLog } from "@/server/debug-logger";
import { getNotificationSettings } from "@/server/notification-settings";
import { getCockpitDir } from "@/server/paths";
import type { WebPushConfig } from "@/types";

/**
 * Web Push: the browser-delivered notification channel.
 *
 * A subscription is per browser profile — per device, in practice — and is
 * identified by the endpoint its push service issued. Cockpit stores one as a
 * notification provider entry of type "webpush", so it inherits the same
 * enabled flag and priority/source filters as Telegram and ntfy, and the same
 * delivery path from the inbox.
 *
 * Sending needs a VAPID key pair: the public half goes to the browser at
 * subscribe time and the private half signs each push. The pair is generated
 * on first use and kept in cockpit's own directory, so restarts and upgrades
 * keep working with the subscriptions already out there.
 */

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let cached: VapidKeys | null = null;

function keysFile(): string {
  return join(getCockpitDir(), "push-keys.json");
}

/** The VAPID key pair, generated and saved the first time it is needed. */
export function getVapidKeys(): VapidKeys {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(readFileSync(keysFile(), "utf-8")) as Partial<VapidKeys>;
    if (parsed.publicKey && parsed.privateKey) {
      cached = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      return cached;
    }
  } catch {
    // First run, or the file was removed: make a new pair below.
  }
  const keys = webpush.generateVAPIDKeys();
  cached = keys;
  try {
    mkdirSync(getCockpitDir(), { recursive: true });
    writeFileSync(keysFile(), `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    debugLog(`[web-push] could not save the VAPID keys: ${String(err)}`);
  }
  return keys;
}

/** Reset the in-process cache. Tests only. */
export function resetVapidCacheForTesting(): void {
  cached = null;
}

/**
 * The contact the push services are given for these messages. VAPID requires
 * one, and a URL that names the deployment is more useful to whoever runs the
 * push service than a placeholder: it is what they would contact before
 * blocking the sender.
 */
function vapidSubject(): string {
  const baseUrl = getNotificationSettings().baseUrl?.trim();
  if (baseUrl && /^https?:\/\//.test(baseUrl)) return baseUrl.replace(/\/$/, "");
  return "mailto:cockpit@localhost";
}

/** Send one push. Throws whatever the push service said, so the caller can
 *  decide whether the subscription is dead. */
export async function sendWebPush(config: WebPushConfig, payload: unknown): Promise<void> {
  const keys = getVapidKeys();
  await webpush.sendNotification(
    { endpoint: config.endpoint, keys: { p256dh: config.keys.p256dh, auth: config.keys.auth } },
    JSON.stringify(payload),
    { vapidDetails: { subject: vapidSubject(), publicKey: keys.publicKey, privateKey: keys.privateKey } },
  );
}

/** A push service answers 404 or 410 for an endpoint it has forgotten — the
 *  browser was uninstalled, or the subscription expired. Retrying it forever
 *  is pointless, and the entry it belongs to should go. */
export function isDeadSubscription(err: unknown): boolean {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  return status === 404 || status === 410;
}
