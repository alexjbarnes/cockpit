import type { NotificationPayload, NotificationProviderEntry, NtfyConfig, TelegramConfig } from "@/types";
import { debugLog } from "./debug-logger";
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

const MAX_NOTIFY_ATTEMPTS = 3;
const NOTIFY_TIMEOUT_MS = 10_000;

function notifyBackoffMs(attempt: number): number {
  // No backoff under vitest so retry tests stay fast.
  if (process.env.VITEST || process.env.NODE_ENV === "test") return 0;
  return 300 * 2 ** (attempt - 1);
}

/**
 * POST a notification with a per-attempt timeout and bounded retry.
 * dispatchNotification fires this without awaiting, so without it a single
 * transient failure — a hung keep-alive socket (no timeout means it hangs
 * forever and never even logs), an ntfy rate-limit, a network blip — silently
 * drops the push while the inbox entry has already persisted. Retries network
 * and timeout errors plus 429/5xx; fails fast on other 4xx (config errors that
 * will not recover by retrying).
 */
async function postWithRetry(label: string, url: string, init: RequestInit): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_NOTIFY_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
    let permanent = false;
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.ok) return;
      const body = await res.text().catch(() => "");
      lastErr = new Error(`${label} ${res.status}: ${body}`);
      permanent = res.status < 500 && res.status !== 429;
    } catch (err) {
      lastErr = err; // network error or timeout abort — retryable
    } finally {
      clearTimeout(timer);
    }
    if (permanent) break;
    if (attempt < MAX_NOTIFY_ATTEMPTS) {
      debugLog(
        `[notifications] ${label} attempt ${attempt}/${MAX_NOTIFY_ATTEMPTS} failed, retrying: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      );
      await new Promise((r) => setTimeout(r, notifyBackoffMs(attempt)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label}: ${String(lastErr)}`);
}

const telegramProvider: NotificationProvider<TelegramConfig> = {
  async send(payload, config, baseUrl) {
    const text = formatPlainMessage(payload, baseUrl);
    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    await postWithRetry("Telegram API", url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
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
    await postWithRetry("ntfy", url, {
      method: "POST",
      headers,
      body: payload.body,
    });
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
    if (payload.providerIds) {
      if (!payload.providerIds.includes(entry.id)) continue;
    } else {
      if (!matchesFilter(entry, payload)) continue;
    }
    const provider = getProvider(entry.type);
    if (!provider) continue;
    provider.send(payload, entry.config as never, settings.baseUrl).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[notifications] ${entry.type}/${entry.name} failed:`, err);
      debugLog(`[notifications] ${entry.type}/${entry.name} failed after retries: ${message}`);
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
