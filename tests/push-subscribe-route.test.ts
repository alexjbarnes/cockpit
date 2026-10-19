// Registering a browser as a notification provider, and forgetting it again.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  providers: [] as Array<Record<string, unknown>>,
  writes: [] as Array<Array<Record<string, unknown>>>,
  publicKey: "vapid-public-key",
}));

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));

vi.mock("@/server/notification-settings", () => ({
  getNotificationSettings: () => ({ providers: h.providers }),
  updateNotificationSettings: (partial: { providers: Array<Record<string, unknown>> }) => {
    h.providers = partial.providers;
    h.writes.push(partial.providers);
    return { providers: h.providers };
  },
}));

vi.mock("@/server/web-push", () => ({
  getVapidKeys: () => ({ publicKey: h.publicKey, privateKey: "private" }),
}));

import { DELETE, GET, POST } from "@/app/api/push/subscribe/route";

function req(method: string, body?: unknown, authed = true): NextRequest {
  return new NextRequest("http://localhost/api/push/subscribe", {
    method,
    headers: {
      ...(authed ? { cookie: "cockpit_session=valid" } : {}),
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const subscription = {
  endpoint: "https://push.example/device-1",
  keys: { p256dh: "p256dh-value", auth: "auth-value" },
  label: "Chrome on Android",
};

describe("the push subscribe route", () => {
  beforeEach(() => {
    h.providers = [];
    h.writes = [];
  });

  it("hands out the public half of the key pair", async () => {
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    expect((await res.json()).publicKey).toBe("vapid-public-key");
  });

  it("stores a subscription as a provider of its own type", async () => {
    const res = await POST(req("POST", subscription));
    expect(res.status).toBe(200);

    const stored = h.providers[0];
    expect(stored).toMatchObject({
      type: "webpush",
      enabled: true,
      name: "Chrome on Android",
      config: { endpoint: subscription.endpoint, keys: { p256dh: "p256dh-value", auth: "auth-value" }, label: "Chrome on Android" },
    });
    expect(h.providers, "no second entry for one device").toHaveLength(1);
  });

  // The push service hands back the same endpoint when the same browser
  // subscribes again, so a repeat is the same device rather than a new one.
  it("re-enables the existing entry instead of adding a second", async () => {
    h.providers = [
      {
        id: "p1",
        type: "webpush",
        enabled: false,
        name: "Old name",
        config: { endpoint: subscription.endpoint, keys: { p256dh: "old", auth: "old" }, label: "Old name" },
      },
    ];

    const res = await POST(req("POST", subscription));

    expect((await res.json()).rejoined).toBe(true);
    expect(h.providers).toHaveLength(1);
    expect(h.providers[0]).toMatchObject({
      id: "p1",
      enabled: true,
      // The name stays as it was: a device the user renamed keeps that name,
      // and the keys are refreshed because the browser just issued them.
      name: "Old name",
      config: { endpoint: subscription.endpoint, keys: { p256dh: "p256dh-value", auth: "auth-value" } },
    });
  });

  it("names a device it was not told about", async () => {
    await POST(req("POST", { endpoint: subscription.endpoint, keys: subscription.keys }));
    expect(h.providers[0].name).toBe("This device");
  });

  it("refuses an incomplete subscription, and anything unauthenticated", async () => {
    expect((await POST(req("POST", { endpoint: subscription.endpoint }))).status).toBe(400);
    expect((await POST(req("POST", subscription, false))).status).toBe(401);
    expect((await GET(req("GET", undefined, false))).status).toBe(401);
    expect(h.writes).toEqual([]);
  });

  it("removes one subscription by its endpoint, leaving the others", async () => {
    h.providers = [
      { id: "a", type: "webpush", enabled: true, name: "A", config: { endpoint: "https://push.example/a", keys: {} } },
      { id: "b", type: "webpush", enabled: true, name: "B", config: { endpoint: subscription.endpoint, keys: {} } },
    ];

    const res = await DELETE(req("DELETE", { endpoint: subscription.endpoint }));

    expect((await res.json()).removed).toBe(true);
    expect(h.providers.map((p) => p.id)).toEqual(["a"]);
  });

  it("reports an endpoint it does not know rather than writing", async () => {
    const res = await DELETE(req("DELETE", { endpoint: "https://push.example/gone" }));
    expect((await res.json()).removed).toBe(false);
    expect(h.writes).toEqual([]);
  });
});
