// Web Push: the key pair, what a push carries, and what a push service's
// answer means for the subscription it was sent to.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sent: [] as Array<{ subscription: unknown; payload: string; options: unknown }>,
  generate: vi.fn(() => ({ publicKey: "generated-public", privateKey: "generated-private" })),
  sendBehaviour: null as null | (() => Promise<never>),
  settings: { baseUrl: undefined as string | undefined },
}));

vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: h.generate,
    sendNotification: async (subscription: unknown, payload: string, options: unknown) => {
      if (h.sendBehaviour) await h.sendBehaviour();
      h.sent.push({ subscription, payload, options });
    },
  },
}));

vi.mock("@/server/notification-settings", () => ({
  getNotificationSettings: () => ({ providers: [], baseUrl: h.settings.baseUrl }),
}));

import { getVapidKeys, isDeadSubscription, resetVapidCacheForTesting, sendWebPush } from "@/server/web-push";

let root: string;
let prevCockpit: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cockpit-push-"));
  prevCockpit = process.env.COCKPIT_CONFIG_DIR;
  process.env.COCKPIT_CONFIG_DIR = root;
  resetVapidCacheForTesting();
  h.sent = [];
  h.settings = { baseUrl: undefined };
  h.sendBehaviour = null;
  h.generate.mockClear();
});

afterEach(() => {
  if (prevCockpit === undefined) delete process.env.COCKPIT_CONFIG_DIR;
  else process.env.COCKPIT_CONFIG_DIR = prevCockpit;
  rmSync(root, { recursive: true, force: true });
});

const config = { endpoint: "https://push.example/abc", keys: { p256dh: "p256dh-key", auth: "auth-key" } };

describe("the VAPID key pair", () => {
  it("is generated once and kept, so existing subscriptions keep working", () => {
    const first = getVapidKeys();
    expect(first).toEqual({ publicKey: "generated-public", privateKey: "generated-private" });
    expect(h.generate).toHaveBeenCalledTimes(1);

    // A restart reads the same pair back rather than minting a new one, which
    // would strand every subscription already out there.
    resetVapidCacheForTesting();
    expect(getVapidKeys()).toEqual(first);
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it("is written where only its owner can read it", () => {
    getVapidKeys();
    const file = path.join(root, "push-keys.json");
    expect(JSON.parse(readFileSync(file, "utf-8")).privateKey).toBe("generated-private");
    expect(statSync(file).mode & 0o077, "no group or other access — the private half signs every push").toBe(0);
  });
});

describe("sending a push", () => {
  it("carries the message the service worker will show, and the key that signs it", async () => {
    await sendWebPush(config, { title: "Job failed", body: "Weekly organiser", url: "https://cockpit.test/inbox/abc" });

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].subscription).toEqual({ endpoint: config.endpoint, keys: { p256dh: "p256dh-key", auth: "auth-key" } });
    expect(JSON.parse(h.sent[0].payload)).toEqual({
      title: "Job failed",
      body: "Weekly organiser",
      url: "https://cockpit.test/inbox/abc",
    });
    const options = h.sent[0].options as { vapidDetails: { subject: string; publicKey: string; privateKey: string } };
    expect(options.vapidDetails.publicKey).toBe("generated-public");
    expect(options.vapidDetails.privateKey).toBe("generated-private");
  });

  // The push services want someone to contact before blocking a sender, and
  // the deployment's own URL is more use to them than a placeholder.
  it("names the deployment as the VAPID contact when a base url is set", async () => {
    h.settings.baseUrl = "https://cockpit.test/";
    await sendWebPush(config, { title: "t", body: "b" });
    const options = h.sent[0].options as { vapidDetails: { subject: string } };
    expect(options.vapidDetails.subject).toBe("https://cockpit.test");
  });

  it("falls back to a local address when it is not", async () => {
    await sendWebPush(config, { title: "t", body: "b" });
    const options = h.sent[0].options as { vapidDetails: { subject: string } };
    expect(options.vapidDetails.subject).toBe("mailto:cockpit@localhost");
  });
});

describe("a subscription the push service has forgotten", () => {
  it("is recognised from the status it answers with", () => {
    expect(isDeadSubscription({ statusCode: 404 })).toBe(true);
    expect(isDeadSubscription({ statusCode: 410 })).toBe(true);
    expect(isDeadSubscription({ statusCode: 500 })).toBe(false);
    expect(isDeadSubscription(new Error("network down"))).toBe(false);
  });
});
