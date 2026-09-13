// Offline shell for the EMOM timer.
//
// CACHE is stamped by ./scripts/stamp.sh from a hash of the assets below -- do
// not edit it by hand. Run it before deploying; the activate handler then drops
// whatever the previous hash was.

const CACHE = "emom-7bde955ede72";
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

  // ignoreSearch so a bookmarked ?rounds=12 still hits the cached shell.
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
