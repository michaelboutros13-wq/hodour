/* Offline support: keeps the app on the phone after the first visit, so it opens with no internet. */
const VERSION = "ssa-cloud-56eebd99a7";
const CORE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  // cache: "reload" skips the browser's own HTTP cache, so an update never keeps an old copy.
  // Each file on its own: one that fails (weak network) doesn't stop the rest from being kept.
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => Promise.allSettled(CORE.map((u) => c.add(new Request(u, { cache: "reload" })))))
      .then(async (results) => {
        // the page itself is a must; without it, stay on the old version and try again later
        const page = await caches.open(VERSION).then((c) => c.match("./index.html"));
        if (!page) throw new Error("index.html not cached");
        return results;
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

/** Network with a time limit: a weak or fake connection doesn't keep the app waiting. */
function fetchWithin(req, ms, init) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("slow")), ms);
    fetch(req, init).then(
      (r) => {
        clearTimeout(t);
        resolve(r);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // The app page: the copy on the phone, right away. A new version arrives through a new
  // sw.js (the browser checks it by itself), and shows the next time the app is opened.
  if (req.mode === "navigate") {
    event.respondWith(
      caches.open(VERSION).then(async (c) => {
        const saved = (await c.match("./index.html")) || (await c.match("./"));
        if (saved) return saved;
        // first visit: from the network, and keep it
        const res = await fetch(req, { cache: "no-cache" });
        if (res.ok) c.put("./index.html", res.clone());
        return res;
      }),
    );
    return;
  }

  // The app's name and icon list: saved copy first, refreshed in the background.
  if (url.origin === self.location.origin && url.pathname.endsWith("manifest.webmanifest")) {
    event.respondWith(
      caches.match("./manifest.webmanifest").then((hit) => {
        const fresh = fetchWithin(req, 4000, { cache: "no-cache" })
          .then((res) => {
            if (res.ok) caches.open(VERSION).then((c) => c.put("./manifest.webmanifest", res.clone()));
            return res;
          })
          .catch(() => hit);
        return hit || fresh;
      }),
    );
    return;
  }

  // Everything else (fonts, icons): saved copy first, then the network.
  const cacheable = url.origin === self.location.origin || /(^|\.)(jsdelivr\.net|googleapis\.com|gstatic\.com)$/.test(url.hostname);
  if (!cacheable) return;
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok || res.type === "opaque") {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
