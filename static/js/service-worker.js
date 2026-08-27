"use strict";

const CORE_CACHE = "jfcm-offline-core-v2";
const SCOPE_CACHE = "jfcm-offline-scope-v2";
const ITEM_CACHE_PREFIX = "jfcm-offline-item-v2-";
const PUBLIC_ITEM_PREFIX = ITEM_CACHE_PREFIX + "public-";
const OFFLINE_FALLBACK_URL = "/static/offline.html";
const SCOPE_STATE_URL = "/__jfcm_offline_scope__";
const CORE_URLS = [
  OFFLINE_FALLBACK_URL,
  "/static/css/style.css",
  "/static/js/app.js",
  "/static/images/JF.ico",
  "/static/images/JF.png"
];

let activeScope = "public";

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CORE_CACHE).then(function (cache) {
      return Promise.allSettled(CORE_URLS.map(function (url) { return cache.add(url); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

async function readScope() {
  const cache = await caches.open(SCOPE_CACHE);
  const response = await cache.match(SCOPE_STATE_URL);
  if (!response) return "public";
  const scope = await response.text();
  return /^(public|private-[a-z0-9]+)$/.test(scope) ? scope : "public";
}

async function setScope(scope) {
  if (!/^(public|private-[a-z0-9]+)$/.test(scope)) return;
  activeScope = scope;
  const cache = await caches.open(SCOPE_CACHE);
  await cache.put(SCOPE_STATE_URL, new Response(scope, { headers: { "Content-Type": "text/plain" } }));

  const names = await caches.keys();
  const allowedPrivatePrefix = scope.startsWith("private-") ? ITEM_CACHE_PREFIX + scope + "-" : null;
  await Promise.all(names.filter(function (name) {
    return name.startsWith(ITEM_CACHE_PREFIX + "private-") && (!allowedPrivatePrefix || !name.startsWith(allowedPrivatePrefix));
  }).map(function (name) { return caches.delete(name); }));
}

self.addEventListener("message", function (event) {
  if (!event.data || event.data.type !== "SET_OFFLINE_SCOPE") return;
  event.waitUntil(setScope(String(event.data.scope || "public")));
});

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    const names = await caches.keys();
    await Promise.all(names.filter(function (name) {
      return name === "jfcm-offline-core-v1" || name.startsWith("jfcm-offline-item-v1-");
    }).map(function (name) { return caches.delete(name); }));
    activeScope = await readScope();
    await self.clients.claim();
  })());
});

async function cachedResponse(request) {
  const cacheNames = await caches.keys();
  const privatePrefix = activeScope.startsWith("private-") ? ITEM_CACHE_PREFIX + activeScope + "-" : null;
  const offlineCaches = cacheNames.filter(function (name) {
    return name === CORE_CACHE || name.startsWith(PUBLIC_ITEM_PREFIX) || (privatePrefix && name.startsWith(privatePrefix));
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
    fetch(event.request).catch(function () { return offlineFallback(event.request); })
  );
});

async function offlineFallback(request) {
  try {
    const cached = await cachedResponse(request);
    if (cached) return rangedResponse(request, cached);

    if (request.mode === "navigate" || request.destination === "document") {
      const core = await caches.open(CORE_CACHE);
      const fallback = await core.match(OFFLINE_FALLBACK_URL);
      if (fallback) return fallback;
      return new Response("<!doctype html><title>Offline</title><h1>You are offline</h1><p>This page was not saved for offline access.</p>", {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
  } catch (_error) {
    // A FetchEvent response must always resolve, including when Cache Storage fails.
  }
  return new Response("Offline resource is not cached", {
    status: 503,
    statusText: "Offline",
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
