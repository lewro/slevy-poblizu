const CACHE_NAME = "slevy-poblizu-v1";
const SHELL = ["/", "/manifest.json", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Network-first, falling back to cache - keeps the app shell available
// offline without ever serving stale deal data.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// Real push from the server (web-push), works while the device is on and
// the browser/OS keeps the service worker alive - most reliable on Android.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Sleva poblíž", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Sleva poblíž";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});

// Best-effort background check (Chrome on Android only). The browser
// decides the actual interval based on engagement/battery/network - this is
// NOT real-time geofencing, just a periodic nudge while the app is closed.
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "check-nearby-deals") {
    event.waitUntil(checkNearbyDeals());
  }
});

async function checkNearbyDeals() {
  try {
    const res = await fetch("/api/check-proximity", { method: "POST" });
    const data = await res.json();
    for (const v of data.nearby || []) {
      await self.registration.showNotification(`Sleva poblíž: ${v.name}`, {
        body: `${v.offer} · ${v.distance} m od vás`,
        icon: "/icons/icon-192.png",
      });
    }
  } catch (e) {
    // offline or server unreachable - silently skip this cycle
  }
}
