import type { NotificationPayload, NotificationProviderEntry, NtfyConfig, TelegramConfig } from "@/types";
import { getNotificationSettings } from "./notification-settings";

interface NotificationProvider<C = unknown> {
  send(payload: NotificationPayload, config: C, baseUrl?: string): Promise<void>;
}

function buildFullUrl(path: string | undefined, baseUrl: string | undefined): string | undefined {
  if (!path) return undefined;
  if (baseUrl) return `${baseUrl.replace(/\/$/, "")}${path}`;
  return path;
}

function formatPlainMessage(payload: NotificationPayload, baseUrl?: string): string {
  const priorityTag = payload.priority === "error" ? "[ERROR]" : payload.priority === "warning" ? "[WARN]" : "";
  const prefix = priorityTag ? `${priorityTag} ` : "";
  const url = buildFullUrl(payload.url, baseUrl);
  const link = url ? `\n\n${url}` : "";
  return `${prefix}${payload.title}\n\n${payload.body}${link}`;
}

const telegramProvider: NotificationProvider<TelegramConfig> = {
  async send(payload, config, baseUrl) {
    const text = formatPlainMessage(payload, baseUrl);
    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram API ${res.status}: ${body}`);
    }
  },
};

const ntfyProvider: NotificationProvider<NtfyConfig> = {
  async send(payload, config, baseUrl) {
    const serverUrl = (config.serverUrl || "https://ntfy.sh").replace(/\/$/, "");
    const url = `${serverUrl}/${config.topic}`;
    const fullUrl = buildFullUrl(payload.url, baseUrl);
    const headers: Record<string, string> = {
      Title: payload.title,
      Priority: payload.priority === "error" ? "urgent" : payload.priority === "warning" ? "high" : "default",
    };
    if (config.token) {
      headers.Authorization = `Bearer ${config.token}`;
    }
    if (fullUrl) {
      headers.Click = fullUrl;
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: payload.body,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ntfy ${res.status}: ${body}`);
    }
  },
};

function getProvider(type: string): NotificationProvider<never> | null {
  switch (type) {
    case "telegram":
      return telegramProvider as NotificationProvider<never>;
    case "ntfy":
      return ntfyProvider as NotificationProvider<never>;
    default:
      return null;
  }
}

function matchesFilter(entry: NotificationProviderEntry, payload: NotificationPayload): boolean {
  if (!entry.filter) return true;
  if (entry.filter.priorities?.length && !entry.filter.priorities.includes(payload.priority)) {
    return false;
  }
  if (entry.filter.sources?.length && !entry.filter.sources.includes(payload.source)) {
    return false;
  }
  return true;
}

export function dispatchNotification(payload: NotificationPayload): void {
  const settings = getNotificationSettings();
  for (const entry of settings.providers) {
    if (!entry.enabled) continue;
    if (payload.providerIds?.length) {
      if (!payload.providerIds.includes(entry.id)) continue;
    } else {
      if (!matchesFilter(entry, payload)) continue;
    }
    const provider = getProvider(entry.type);
    if (!provider) continue;
    provider.send(payload, entry.config as never, settings.baseUrl).catch((err) => {
      console.error(`[notifications] ${entry.type}/${entry.name} failed:`, err);
    });
  }
}

export async function sendTestNotification(entry: NotificationProviderEntry, baseUrl?: string): Promise<string> {
  const provider = getProvider(entry.type);
  if (!provider) return `Unknown provider type: ${entry.type}`;
  const payload: NotificationPayload = {
    title: "Cockpit Test Notification",
    body: "This is a test notification from Cockpit.",
    priority: "info",
    source: "test",
    url: "/inbox",
  };
  try {
    await provider.send(payload, entry.config as never, baseUrl);
    return "ok";
  } catch (err) {
    return `Failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
