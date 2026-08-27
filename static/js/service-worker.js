"use strict";

const CORE_CACHE = "jfcm-offline-core-v1";
const ITEM_CACHE_PREFIX = "jfcm-offline-item-v1-";
const CORE_URLS = [
  "/static/css/style.css",
  "/static/js/app.js",
  "/static/images/JF.ico"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CORE_CACHE).then(function (cache) {
      return Promise.allSettled(CORE_URLS.map(function (url) { return cache.add(url); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

async function cachedResponse(request) {
  const cacheNames = await caches.keys();
  const offlineCaches = cacheNames.filter(function (name) {
    return name === CORE_CACHE || name.startsWith(ITEM_CACHE_PREFIX);
  });
  for (const cacheName of offlineCaches) {
    const cache = await caches.open(cacheName);
    const response = await cache.match(request, { ignoreVary: true });
    if (response) return response;
  }
  return null;
}

async function rangedResponse(request, response) {
  const range = request.headers.get("range");
  if (!range || !response || response.status !== 200) return response;
  const match = /bytes=(\d+)-(\d*)/.exec(range);
  if (!match) return response;
  const buffer = await response.arrayBuffer();
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : buffer.byteLength - 1;
  const end = Math.min(requestedEnd, buffer.byteLength - 1);
  if (start > end || start >= buffer.byteLength) {
    return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + buffer.byteLength } });
  }
  const headers = new Headers(response.headers);
  headers.set("Content-Range", "bytes " + start + "-" + end + "/" + buffer.byteLength);
  headers.set("Content-Length", String(end - start + 1));
  headers.set("Accept-Ranges", "bytes");
  return new Response(buffer.slice(start, end + 1), { status: 206, statusText: "Partial Content", headers: headers });
}

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(async function () {
      const cached = await cachedResponse(event.request);
      if (!cached) throw new Error("Offline resource is not cached");
      return rangedResponse(event.request, cached);
    })
  );
});
