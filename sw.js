// Offline shell for the EMOM timer.
//
// CACHE is rewritten to the deployed commit by scripts/inject-build.sh, which
// the deploy workflow runs. Do not edit it by hand. A checkout that was never
// deployed keeps "dev", which is correct: it is not any published build.

const CACHE = "emom-dev";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate. Cache-first alone would pin the app to whatever
// shipped first; network-first would stall on the weak signal this exists to
// survive. Serving the cache and refreshing behind it costs one reload of
// staleness and is never slow, never broken.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  // The app generates no query strings of its own, but a shared link can pick
  // one up (?utm_source=...). ignoreSearch keeps those hitting the cached
  // shell instead of failing offline.
  const hit = caches.match(e.request, { ignoreSearch: true });

  const fresh = fetch(e.request)
    .then(async (res) => {
      if (res.ok) {
        const c = await caches.open(CACHE);
        await c.put(e.request, res.clone());
      }
      return res;
    })
    .catch(() => hit);

  // The revalidate outlives respondWith, and the browser is free to kill an
  // idle worker the moment that settles. waitUntil is what keeps it alive long
  // enough for the put to land.
  e.waitUntil(fresh);
  e.respondWith(hit.then((cached) => cached || fresh));
});
