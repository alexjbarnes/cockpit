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
// should land all travel in it. Nothing is fetched here — the notification must
// appear whether or not the app is open, and whether or not it can reach the
// server, since that is the point of a push.

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
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      icon: "/icon-192.png",
      // Android draws only the alpha of this one, in white: a colour icon
      // arrives as a white square. See scripts/make-notification-badge.mjs.
      badge: "/notification-badge.png",
      tag: payload.tag || undefined,
      data: { url: payload.url || "/inbox" },
    })
  );
});

// A tap focuses a window already showing cockpit rather than opening a second
// one, and lands on the page the notification named.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/inbox", self.location.origin).href;
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
