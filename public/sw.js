// Shmearify service worker
// Bump CACHE_NAME on every deploy so stale shells/assets are flushed.
const CACHE_NAME = "shmearify-v4";

const SHELL_URLS = ["/", "/index.html"];
const STATIC_ASSETS = [
  "/app.js",
  "/styles.css",
  "/manifest.json",
  "/profile.jpg",
  "/header.jpg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isAudioOrArt(req) {
  const url = new URL(req.url);
  return url.pathname.startsWith("/stream/") || url.pathname.startsWith("/art/");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never cache dynamic audio streams or artwork.
  if (isAudioOrArt(req)) {
    return event.respondWith(fetch(req));
  }

  // HTML shell: network-first, fall back to cache so deploys reach clients quickly.
  if (req.mode === "navigate" || SHELL_URLS.includes(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req).then((res) => res || caches.match("/")))
    );
    return;
  }

  // Static assets: cache-first with background refresh.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
