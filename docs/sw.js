/* Offline cache for Campus Buddy. Bump CACHE when the asset list changes. */
var CACHE = "campus-buddy-v6";
var ASSETS = [
  ".", "index.html", "app.js", "schedule.js", "calendar.js", "mess.js", "map.js", "manifest.webmanifest",
  "icon-192.png", "icon-512.png", "icon-maskable.png", "apple-touch-icon.png", "favicon.png",
];
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  // Network-first, so a new version shows up as soon as there is a connection;
  // the cache is the offline fallback (and is refreshed on every successful load).
  e.respondWith(fetch(e.request).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      return hit || caches.match("index.html");
    });
  }));
});
