// public/sw.js only ever runs in a browser, so nothing else in the suite loads
// it. Executing it here in a bare sandbox with a fake `self` is enough to pin
// the two handlers that carry cockpit behaviour: what a push shows, and what
// the notification's own buttons do when they are tapped.
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

interface FakeClient {
  url: string;
  navigate: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
}

function loadServiceWorker() {
  const code = readFileSync(path.join(process.cwd(), "public", "sw.js"), "utf8");
  const handlers: Record<string, (event: never) => void> = {};
  const notifications: Array<{ title: string; options: Record<string, unknown> }> = [];
  const fetched: Array<{ url: string; init: RequestInit | undefined }> = [];
  const opened: string[] = [];
  const clients: FakeClient[] = [];

  const self = {
    addEventListener: (type: string, fn: (event: never) => void) => {
      handlers[type] = fn;
    },
    location: { origin: "https://cockpit.example" },
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        notifications.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      matchAll: () => Promise.resolve(clients),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve();
      },
    },
    skipWaiting: () => {},
  };

  const sandbox = {
    self,
    fetch: (url: string, init?: RequestInit) => {
      fetched.push({ url, init });
      return Promise.resolve({ ok: true });
    },
    URL,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  return { handlers, notifications, fetched, opened, clients };
}

/** Fire a push and wait for what its handler asked to be waited for. */
async function push(sw: ReturnType<typeof loadServiceWorker>, payload: unknown) {
  const waits: Array<Promise<unknown>> = [];
  sw.handlers.push({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => waits.push(p) } as never);
  await Promise.all(waits);
}

/** Tap the notification: an action button when one is named, its body otherwise. */
async function click(sw: ReturnType<typeof loadServiceWorker>, action: string, data: Record<string, unknown>) {
  const close = vi.fn();
  const waits: Array<Promise<unknown>> = [];
  sw.handlers.notificationclick({
    action,
    notification: { data, close },
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  } as never);
  await Promise.all(waits);
  return close;
}

describe("service worker push", () => {
  it("gives a notification from the inbox a button to mark it read and one to delete it", async () => {
    const sw = loadServiceWorker();
    await push(sw, { title: "Job failed", body: "Weekly organiser", url: "/inbox/abc", messageId: "abc" });

    const { options } = sw.notifications[0];
    expect(options.actions).toEqual([
      { action: "mark-read", title: "Mark read" },
      { action: "delete", title: "Delete" },
    ]);
    expect(options.data).toMatchObject({ url: "/inbox/abc", messageId: "abc" });
  });

  it("offers Approve and Deny for a permission a session is waiting on", async () => {
    const sw = loadServiceWorker();
    await push(sw, {
      title: "Weekly organiser",
      body: "Needs approval: rm -rf build",
      approval: { sessionId: "sess-1", requestId: "req-1" },
    });

    const { options } = sw.notifications[0];
    expect(options.actions).toEqual([
      { action: "approve", title: "Approve" },
      { action: "deny", title: "Deny" },
    ]);
    expect(options.data).toMatchObject({ approval: { sessionId: "sess-1", requestId: "req-1" } });
  });

  it("gives a push with no inbox message behind it no buttons", async () => {
    const sw = loadServiceWorker();
    await push(sw, { title: "Cockpit", body: "something happened" });

    expect(sw.notifications[0].options.actions).toEqual([]);
  });

  it("still shows something for a push whose body will not parse", async () => {
    const sw = loadServiceWorker();
    const waits: Array<Promise<unknown>> = [];
    sw.handlers.push({
      data: {
        json: () => {
          throw new Error("not json");
        },
      },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    } as never);
    await Promise.all(waits);

    expect(sw.notifications[0].title).toBe("Cockpit");
  });
});

describe("service worker notification buttons", () => {
  it("marks the message read through the same route the inbox page uses", async () => {
    const sw = loadServiceWorker();
    const close = await click(sw, "mark-read", { url: "/inbox/abc", messageId: "abc" });

    expect(sw.fetched[0].url).toBe("/api/inbox/abc");
    expect(sw.fetched[0].init).toMatchObject({ method: "PATCH", body: JSON.stringify({ read: true }) });
    expect(close, "the notification has done its job").toHaveBeenCalled();
    expect(sw.opened, "an action must not open the app").toEqual([]);
  });

  it("deletes the message when that is the button tapped", async () => {
    const sw = loadServiceWorker();
    await click(sw, "delete", { url: "/inbox/abc", messageId: "abc" });

    expect(sw.fetched[0].url).toBe("/api/inbox/abc");
    expect(sw.fetched[0].init?.method).toBe("DELETE");
  });

  it("approves the request through the route the app itself uses", async () => {
    const sw = loadServiceWorker();
    const close = await click(sw, "approve", { approval: { sessionId: "sess-1", requestId: "req-1" } });

    expect(sw.fetched[0].url).toBe("/api/sessions/sess-1/permissions/req-1");
    expect(sw.fetched[0].init).toMatchObject({ method: "POST", body: JSON.stringify({ allowed: true }) });
    expect(close, "the notification has done its job").toHaveBeenCalled();
    expect(sw.opened, "an action must not open the app").toEqual([]);
  });

  it("denies with allowed false, not just an absent body", async () => {
    const sw = loadServiceWorker();
    await click(sw, "deny", { approval: { sessionId: "sess-1", requestId: "req-1" } });

    expect(sw.fetched[0].init).toMatchObject({ method: "POST", body: JSON.stringify({ allowed: false }) });
  });

  it("opens the message when the body of the notification is tapped", async () => {
    const sw = loadServiceWorker();
    await click(sw, "", { url: "/inbox/abc", messageId: "abc" });

    expect(sw.fetched, "a tap on the body acts on nothing").toEqual([]);
    expect(sw.opened).toEqual(["https://cockpit.example/inbox/abc"]);
  });

  it("focuses a window already showing cockpit instead of opening a second one", async () => {
    const sw = loadServiceWorker();
    const client: FakeClient = { url: "https://cockpit.example/sessions", navigate: vi.fn(), focus: vi.fn() };
    sw.clients.push(client);

    await click(sw, "", { url: "/inbox/abc" });

    expect(client.navigate).toHaveBeenCalledWith("https://cockpit.example/inbox/abc");
    expect(client.focus).toHaveBeenCalled();
    expect(sw.opened).toEqual([]);
  });
});
