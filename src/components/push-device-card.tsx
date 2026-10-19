"use client";

import { BellRing, Loader2, Smartphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { NotificationProviderEntry } from "@/types";

/**
 * Notifications from cockpit itself, on this device.
 *
 * A push subscription belongs to the browser profile, so this card is about the
 * device it is open on: enabling subscribes here and the subscription appears
 * in the list below as a provider called after this browser, with the same
 * enable toggle and filters as Telegram and ntfy.
 *
 * iOS only offers Web Push to an app added to the home screen, and a browser
 * only offers it over HTTPS, so a missing PushManager is normal rather than an
 * error — the card says which of the two it is looking at when it can tell.
 */

/** The subscription key arrives base64url-encoded and subscribe() wants bytes.
 *  A fresh ArrayBuffer, not a view over one, since the signature asks for
 *  BufferSource backed by an ArrayBuffer. */
function decodeKey(base64: string): ArrayBuffer {
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return buffer;
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox\//.test(ua)
    ? "Firefox"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const platform = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Mac/.test(ua)
        ? "Mac"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return platform ? `${browser} on ${platform}` : browser;
}

export function PushDeviceCard({ providers, onChanged }: { providers: NotificationProviderEntry[]; onChanged: () => void }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const entries = providers.filter((p) => p.type === "webpush");

  const refresh = useCallback(async () => {
    const canPush = typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
    setSupported(canPush);
    if (!canPush) return;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const sub = await registration?.pushManager.getSubscription();
      setSubscribed(!!sub);
    } catch {
      setSubscribed(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notifications are blocked for this site.");
      // ready never settles where no worker is registered — which is every
      // development run, since cockpit unregisters it there on purpose — so the
      // wait is bounded and says what is missing rather than spinning.
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (!registration) {
        throw new Error("Cockpit's service worker is not running, so this browser cannot subscribe.");
      }
      const res = await fetch("/api/push/subscribe");
      if (!res.ok) throw new Error("Could not read the push key");
      const { publicKey } = (await res.json()) as { publicKey: string };
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(publicKey),
      });
      const stored = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...sub.toJSON(), label: deviceLabel() }),
      });
      if (!stored.ok) throw new Error("Could not save the subscription");
      setSubscribed(true);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const sub = await registration?.pushManager.getSubscription();
      if (sub) {
        // Tell cockpit first: the endpoint is what names the entry, and it is
        // gone the moment the browser unsubscribes.
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setSubscribed(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="push-device-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Smartphone className="h-4 w-4" /> This device
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {supported === false ? (
          <p className="text-xs text-muted-foreground">
            This browser cannot receive push notifications. On iPhone and iPad, add cockpit to your home screen first (Share → Add to Home
            Screen) and open it from there; Safari only offers push to an installed app.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {subscribed
                ? `Notifications are on for this browser${entries.length > 0 ? ` (${entries.map((e) => e.name).join(", ")})` : ""}. Inbox messages arrive here unless you turn the entry below off.`
                : "Get inbox messages as notifications from cockpit itself, without a Telegram bot or an ntfy topic."}
            </p>
            <div className="flex items-center gap-2">
              {subscribed ? (
                <Button variant="outline" size="sm" onClick={disable} disabled={busy} data-testid="push-disable">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BellRing className="h-3.5 w-3.5" />} Turn off on this device
                </Button>
              ) : (
                <Button size="sm" onClick={enable} disabled={busy} data-testid="push-enable">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BellRing className="h-3.5 w-3.5" />} Enable on this device
                </Button>
              )}
            </div>
          </>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
