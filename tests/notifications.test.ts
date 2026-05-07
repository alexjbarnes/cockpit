import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationSettings } from "@/types";

let mockSettings: NotificationSettings = { providers: [] };
const mockSend = vi.fn().mockResolvedValue(undefined);

vi.mock("@/server/notification-settings", () => ({
  getNotificationSettings: () => mockSettings,
}));

describe("dispatchNotification", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSend.mockResolvedValue(undefined);
    mockSettings = {
      providers: [
        {
          id: "tg-1",
          type: "telegram",
          enabled: true,
          name: "Telegram",
          config: { botToken: "token", chatId: "123" },
        },
        {
          id: "ntfy-1",
          type: "ntfy",
          enabled: true,
          name: "Ntfy",
          config: { serverUrl: "https://ntfy.sh", topic: "test" },
        },
      ],
    };
  });

  it("sends to all matching providers when providerIds is undefined", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const { dispatchNotification } = await import("@/server/notifications");

    dispatchNotification({
      title: "Test",
      body: "body",
      priority: "info",
      source: "inbox",
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    fetchSpy.mockRestore();
  });

  it("sends only to specified providers when providerIds has entries", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const { dispatchNotification } = await import("@/server/notifications");

    dispatchNotification({
      title: "Test",
      body: "body",
      priority: "info",
      source: "inbox",
      providerIds: ["ntfy-1"],
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy.mock.calls[0][0]).toContain("ntfy.sh");
    fetchSpy.mockRestore();
  });

  it("sends to no providers when providerIds is empty array", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const { dispatchNotification } = await import("@/server/notifications");

    dispatchNotification({
      title: "Test",
      body: "body",
      priority: "info",
      source: "inbox",
      providerIds: [],
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("skips disabled providers even when no providerIds filter", async () => {
    mockSettings.providers[0].enabled = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const { dispatchNotification } = await import("@/server/notifications");

    dispatchNotification({
      title: "Test",
      body: "body",
      priority: "info",
      source: "inbox",
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy.mock.calls[0][0]).toContain("ntfy.sh");
    fetchSpy.mockRestore();
  });

  it("respects priority filter when providerIds is undefined", async () => {
    mockSettings.providers[0].filter = { priorities: ["error"] };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const { dispatchNotification } = await import("@/server/notifications");

    dispatchNotification({
      title: "Test",
      body: "body",
      priority: "info",
      source: "inbox",
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy.mock.calls[0][0]).toContain("ntfy.sh");
    fetchSpy.mockRestore();
  });
});
