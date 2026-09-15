// Offline shell for the gym timer.
//
// The build id comes from version.js, which the build rewrites, so this file
// is never touched. Imported scripts are inside the byte-for-byte update check
// (Chrome 78+), so a new version.js is what makes the browser install a new
// worker -- which is the only reason the cache name needs to change at all.
//
// The page registers with updateViaCache: "none". Without it the HTTP cache is
// still consulted for imported scripts, and a stale version.js would hold the
// update back for as long as the host's max-age.
importScripts("./version.js");

const CACHE = `emom-${self.BUILD}`;
const ASSETS = [
  "./",
  "./index.html",
  // Both stylesheets, in the order the page links them. Missing here, an
  // offline load would render the markup unstyled rather than fail outright,
  // which is the worse kind of broken: it looks like the app started.
  "./reset.css",
  "./style.css",
  "./manifest.webmanifest",
  // The page loads this too, for the footer. Precached so an offline load
  // still gets a build id rather than falling back to the "dev" placeholder.
  "./version.js",
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
