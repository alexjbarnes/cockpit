import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationSettings, TelegramConfig } from "@/types";

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

  it("respects source filter when providerIds is undefined", async () => {
    mockSettings.providers[0].filter = { sources: ["job"] };
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

  it("skips providers with unknown type", async () => {
    mockSettings.providers = [
      {
        id: "bad-1",
        type: "unknown" as "telegram",
        enabled: true,
        name: "Bad",
        config: {} as TelegramConfig,
      },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const { dispatchNotification } = await import("@/server/notifications");

    dispatchNotification({
      title: "Test",
      body: "body",
      priority: "info",
      source: "inbox",
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("sends ntfy with token and click url when configured", async () => {
    mockSettings.providers = [
      {
        id: "ntfy-1",
        type: "ntfy",
        enabled: true,
        name: "Ntfy",
        config: { serverUrl: "https://ntfy.sh", topic: "test", token: "secret" },
      },
    ];
    mockSettings.baseUrl = "https://cockpit.local";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const { dispatchNotification } = await import("@/server/notifications");

    dispatchNotification({
      title: "Test",
      body: "body",
      priority: "error",
      source: "inbox",
      url: "/jobs/123",
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
    expect(headers.Click).toBe("https://cockpit.local/jobs/123");
    expect(headers.Priority).toBe("urgent");
    fetchSpy.mockRestore();
  });

  it("sends ntfy warning as high priority", async () => {
    mockSettings.providers = [
      {
        id: "ntfy-1",
        type: "ntfy",
        enabled: true,
        name: "Ntfy",
        config: { serverUrl: "", topic: "test" },
      },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const { dispatchNotification } = await import("@/server/notifications");

    dispatchNotification({
      title: "Test",
      body: "body",
      priority: "warning",
      source: "inbox",
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("ntfy.sh");
    const headers = opts.headers as Record<string, string>;
    expect(headers.Priority).toBe("high");
    fetchSpy.mockRestore();
  });

  it("throws on non-ok telegram response", async () => {
    mockSettings.providers = [
      {
        id: "tg-1",
        type: "telegram",
        enabled: true,
        name: "Telegram",
        config: { botToken: "token", chatId: "123" },
      },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dispatchNotification } = await import("@/server/notifications");

    dispatchNotification({
      title: "Test",
      body: "body",
      priority: "info",
      source: "inbox",
    });

    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled());
    expect(consoleSpy.mock.calls[0][1]).toBeInstanceOf(Error);
    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("throws on non-ok ntfy response", async () => {
    mockSettings.providers = [
      {
        id: "ntfy-1",
        type: "ntfy",
        enabled: true,
        name: "Ntfy",
        config: { serverUrl: "https://ntfy.sh", topic: "test" },
      },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Forbidden", { status: 403 }));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dispatchNotification } = await import("@/server/notifications");

    dispatchNotification({
      title: "Test",
      body: "body",
      priority: "info",
      source: "inbox",
    });

    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled());
    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("handles fetch errors gracefully", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dispatchNotification } = await import("@/server/notifications");

    dispatchNotification({
      title: "Test",
      body: "body",
      priority: "info",
      source: "inbox",
    });

    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled());
    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("retries a transient network failure and then delivers", async () => {
    mockSettings.providers = [
      { id: "ntfy-1", type: "ntfy", enabled: true, name: "Ntfy", config: { serverUrl: "https://ntfy.sh", topic: "test" } },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("socket hang up")).mockResolvedValue(new Response("ok"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dispatchNotification } = await import("@/server/notifications");

    dispatchNotification({ title: "Test", body: "body", priority: "info", source: "inbox" });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(consoleSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("retries a 429 then delivers", async () => {
    mockSettings.providers = [
      { id: "ntfy-1", type: "ntfy", enabled: true, name: "Ntfy", config: { serverUrl: "https://ntfy.sh", topic: "test" } },
    ];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValue(new Response("ok"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dispatchNotification } = await import("@/server/notifications");

    dispatchNotification({ title: "Test", body: "body", priority: "info", source: "inbox" });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(consoleSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("does not retry a 4xx config error", async () => {
    mockSettings.providers = [
      { id: "ntfy-1", type: "ntfy", enabled: true, name: "Ntfy", config: { serverUrl: "https://ntfy.sh", topic: "test" } },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Forbidden", { status: 403 }));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dispatchNotification } = await import("@/server/notifications");

    dispatchNotification({ title: "Test", body: "body", priority: "info", source: "inbox" });

    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("gives up after the retry cap on persistent failure", async () => {
    mockSettings.providers = [
      { id: "ntfy-1", type: "ntfy", enabled: true, name: "Ntfy", config: { serverUrl: "https://ntfy.sh", topic: "test" } },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dispatchNotification } = await import("@/server/notifications");

    dispatchNotification({ title: "Test", body: "body", priority: "info", source: "inbox" });

    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled());
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

describe("sendTestNotification", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns ok on success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const { sendTestNotification } = await import("@/server/notifications");

    const result = await sendTestNotification({
      id: "tg-1",
      type: "telegram",
      enabled: true,
      name: "Telegram",
      config: { botToken: "token", chatId: "123" },
    });

    expect(result).toBe("ok");
    fetchSpy.mockRestore();
  });

  it("returns error message on failure", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("bad token"));
    const { sendTestNotification } = await import("@/server/notifications");

    const result = await sendTestNotification({
      id: "tg-1",
      type: "telegram",
      enabled: true,
      name: "Telegram",
      config: { botToken: "token", chatId: "123" },
    });

    expect(result).toContain("Failed");
    expect(result).toContain("bad token");
    fetchSpy.mockRestore();
  });

  it("returns error for unknown provider type", async () => {
    const { sendTestNotification } = await import("@/server/notifications");

    const result = await sendTestNotification({
      id: "bad-1",
      type: "unknown" as "telegram",
      enabled: true,
      name: "Bad",
      config: {} as TelegramConfig,
    });

    expect(result).toContain("Unknown provider type");
  });
});
