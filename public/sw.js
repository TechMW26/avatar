const SW_BUILD = new URL(self.location.href).searchParams.get("b") || "dev";
const CACHE_PREFIX = "rishi-sandipani-";
const CACHE_NAME = `${CACHE_PREFIX}${SW_BUILD}`;
const PRECACHE_URLS = ["/", "/talk"];

const NO_CACHE_PATTERNS = [/\.glb/, /\.gltf/, /avatar/];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  if (NO_CACHE_PATTERNS.some((p) => p.test(url.pathname))) return;
  if (url.hostname !== self.location.hostname) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
