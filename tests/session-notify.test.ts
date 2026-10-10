// What a session sends out when it finishes, asks, or waits for approval:
// one provider, three switches, and the banner the app raises regardless of
// whether the session itself is set up to send anything.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionAttentionEvent } from "@/server/session-attention";

const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  defaults: { sessionAlerts: false },
  providers: [] as Array<{ id: string; enabled: boolean; type: string; name: string }>,
}));

vi.mock("@/server/notifications", () => ({ dispatchNotification: h.dispatch }));
vi.mock("@/server/defaults", () => ({ getDefaults: () => ({ sessionAlerts: h.defaults.sessionAlerts }) }));
vi.mock("@/server/notification-settings", () => ({
  getNotificationSettings: () => ({ providers: h.providers }),
}));

import { onSessionAttention } from "@/server/session-attention";
import { notifySessionEvent, resetSessionNotifyState } from "@/server/session-notify";

const ctx = {
  sessionId: "sess-1",
  name: "Weekly organiser",
  cwd: "/home/dev/repos/cockpit",
  notifications: {
    providerId: "push-1",
    events: { finished: true, question: true, permission: true },
  },
};

let attention: SessionAttentionEvent[] = [];
let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionNotifyState();
  h.defaults = { sessionAlerts: false };
  h.providers = [{ id: "push-1", enabled: true, type: "webpush", name: "Chrome on Pixel" }];
  attention = [];
  unsubscribe?.();
  unsubscribe = onSessionAttention((event) => attention.push(event));
});

describe("the banner the app raises", () => {
  it("goes out for a session with no notification settings of its own", () => {
    h.defaults = { sessionAlerts: true };

    notifySessionEvent({ ...ctx, notifications: undefined }, "permission", { requestId: "req-1", toolName: "Bash", input: "{}" });

    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ sessionId: "sess-1", kind: "permission", requestId: "req-1" });
    expect(h.dispatch, "no provider, so nothing is sent").not.toHaveBeenCalled();
  });

  it("is silent when the global switch is off", () => {
    notifySessionEvent(ctx, "question", { requestId: "req-1" });
    expect(attention).toEqual([]);
  });
});

describe("the message a session sends", () => {
  it("carries the provider, the session's name and where to open it", () => {
    notifySessionEvent(ctx, "permission", { requestId: "req-1", toolName: "Bash", input: JSON.stringify({ command: "rm -rf build" }) });

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const payload = h.dispatch.mock.calls[0][0];
    expect(payload).toMatchObject({
      title: "Weekly organiser",
      priority: "warning",
      source: "session",
      providerIds: ["push-1"],
      url: "/sessions/sess-1?cwd=%2Fhome%2Fdev%2Frepos%2Fcockpit",
      approval: { sessionId: "sess-1", requestId: "req-1" },
    });
    expect(payload.body).toBe("Needs approval: rm -rf build");
  });

  it("says what was asked", () => {
    notifySessionEvent(ctx, "question", {
      requestId: "req-2",
      toolName: "AskUserQuestion",
      input: JSON.stringify({ questions: [{ question: "Which database?" }] }),
    });

    expect(h.dispatch.mock.calls[0][0].body).toBe("Asked: Which database?");
  });

  it("sends nothing for a kind that is switched off", () => {
    notifySessionEvent({ ...ctx, notifications: { providerId: "push-1", events: { finished: true } } }, "permission", {
      requestId: "req-1",
      toolName: "Bash",
      input: "{}",
    });

    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("sends nothing when the chosen provider is gone or switched off", () => {
    h.providers = [{ id: "push-1", enabled: false, type: "webpush", name: "Chrome on Pixel" }];
    notifySessionEvent(ctx, "finished");
    expect(h.dispatch).not.toHaveBeenCalled();

    h.providers = [];
    notifySessionEvent(ctx, "finished");
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("sends once per request, however often the request is seen", () => {
    const detail = { requestId: "req-9", toolName: "Bash", input: "{}" };
    notifySessionEvent(ctx, "permission", detail);
    notifySessionEvent(ctx, "permission", detail);

    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it("holds back a second 'finished' within a few seconds", () => {
    notifySessionEvent(ctx, "finished");
    notifySessionEvent(ctx, "finished");

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch.mock.calls[0][0].body).toBe("Finished working");
  });
});
