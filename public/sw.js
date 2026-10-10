const CACHE_NAME = "cockpit-shell-v2";
const SHELL_URLS = ["/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only cache same-origin GET requests for static assets
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  // Skip WebSocket upgrade, API calls, and HMR
  if (url.pathname.startsWith("/ws")) return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/_next/webpack-hmr")) return;

  // Network-first for HTML pages
  if (event.request.headers.get("accept")?.includes("text/html")) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for static assets (JS, CSS, images)
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.match(/\.(js|css|png|jpg|svg|woff2?)$/)
  ) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            return response;
          })
      )
    );
    return;
  }
});

// ── Web Push ────────────────────────────────────────────────────────────────
// A push from cockpit carries the inbox message that caused it: the service
// worker has only the payload to work with, so the title, body and where a tap
// should land all travel in it. Nothing is fetched to SHOW it — the
// notification must appear whether or not the app is open, and whether or not
// it can reach the server, since that is the point of a push.

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A push with no readable body still has to show something: a silent push
    // is one the browser is allowed to drop.
    payload = { title: "Cockpit", body: "" };
  }
  const title = payload.title || "Cockpit";
  // The message's id turns the notification into something actionable. Two
  // actions is what a browser will show — Chrome's Notification.maxActions is
  // 2 — and on Android they appear only once the notification is expanded. No
  // id (a push that did not come from the inbox) means no buttons.
  const actions = payload.messageId
    ? [
        { action: "mark-read", title: "Mark read" },
        { action: "delete", title: "Delete" },
      ]
    : [];
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      icon: "/icon-192.png",
      // Android draws only the alpha of this one, in white: a colour icon
      // arrives as a white square. See scripts/make-notification-badge.mjs.
      badge: "/notification-badge.png",
      tag: payload.tag || undefined,
      actions,
      data: { url: payload.url || "/inbox", messageId: payload.messageId },
    })
  );
});

// Acting on the notification itself: the same request the inbox page makes,
// sent straight from here so it works with the app closed. The fetch is
// same-origin, so the session cookie rides with it.
async function actOnMessage(action, id) {
  try {
    const res = await fetch(`/api/inbox/${encodeURIComponent(id)}`, {
      method: action === "delete" ? "DELETE" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: action === "delete" ? undefined : JSON.stringify({ read: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// An action button acts and leaves the app alone. Anything else — a tap on the
// notification body — focuses a window already showing cockpit rather than
// opening a second one, and lands on the page the notification named.
self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  if (event.action === "mark-read" || event.action === "delete") {
    event.notification.close();
    if (data.messageId) {
      event.waitUntil(actOnMessage(event.action, data.messageId));
    }
    return;
  }
  event.notification.close();
  const target = new URL(data.url || "/inbox", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
