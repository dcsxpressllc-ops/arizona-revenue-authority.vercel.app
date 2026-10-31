/**
 * Service worker for push notifications only.
 *
 * Deliberately no `fetch` handler: without one the worker never intercepts
 * network requests, so it can't serve stale assets, break auth redirects or
 * interfere with Firestore streams. Offline support is out of scope; don't
 * add a fetch handler without revisiting that.
 *
 * Payload (JSON, sent by src/lib/push/send.ts):
 *   { title: string, body: string, url: string, tag?: string }
 */

self.addEventListener("install", () => {
  // No fetch handler means no cache state to migrate, so skipping the
  // waiting phase is safe.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "New activity", body: event.data.text(), url: "/dashboard" };
  }
  const title = payload.title || "New activity";
  const options = {
    body: payload.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: payload.tag || undefined,
    data: { url: payload.url || "/dashboard" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/dashboard";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        // Focus an existing app window and navigate it; otherwise open new.
        for (const client of windowClients) {
          if ("focus" in client) {
            client.focus();
            if ("navigate" in client) return client.navigate(url);
            return undefined;
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
