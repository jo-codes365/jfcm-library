"use strict";

const CORE_CACHE = "jfcm-offline-core-v3";
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
  "/static/images/JF.png",
  "/static/css/fonts/Satoshi-Regular.otf",
  "/static/css/fonts/Satoshi-Bold.otf"
];

let activeScope = "public";

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CORE_CACHE).then(function (cache) {
      return cache.addAll(CORE_URLS);
    }).then(function () { return self.skipWaiting(); })
  );
});

async function readScope() {
  try {
    const cache = await caches.open(SCOPE_CACHE);
    const response = await cache.match(SCOPE_STATE_URL);
    if (!response) return "public";
    const scope = await response.text();
    return /^(public|private-[a-z0-9]+)$/.test(scope) ? scope : "public";
  } catch (_error) {
    return activeScope || "public";
  }
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
  const update = setScope(String(event.data.scope || "public"));
  if (event.ports && event.ports[0]) {
    update.then(function () { event.ports[0].postMessage({ ok: true }); })
      .catch(function () { event.ports[0].postMessage({ ok: false }); });
  }
  event.waitUntil(update.catch(function () {}));
});

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    const names = await caches.keys();
    await Promise.all(names.filter(function (name) {
      return name === "jfcm-offline-core-v1" || name === "jfcm-offline-core-v2" || name.startsWith("jfcm-offline-item-v1-");
    }).map(function (name) { return caches.delete(name); }));
    activeScope = await readScope();
    await self.clients.claim();
  })());
});

async function cachedResponse(request) {
  // A worker can be terminated and restarted without another activate event.
  // Restore the persisted session scope before looking in private caches.
  activeScope = await readScope();
  const cacheNames = await caches.keys();
  const privatePrefix = activeScope.startsWith("private-") ? ITEM_CACHE_PREFIX + activeScope + "-" : null;
  const offlineCaches = cacheNames.filter(function (name) {
    return name === CORE_CACHE || name.startsWith(PUBLIC_ITEM_PREFIX) || (privatePrefix && name.startsWith(privatePrefix));
  });
  for (const cacheName of offlineCaches) {
    const cache = await caches.open(cacheName);
    const response = await cache.match(request, { ignoreVary: true });
    if (response instanceof Response) return response.clone();
  }
  return null;
}

async function rangedResponse(request, response) {
  const range = request.headers.get("range");
  if (!range || !(response instanceof Response) || response.status !== 200) return response;
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

async function offlineFallback(request) {
  try {
    if (request.method === "GET") {
      const cached = await cachedResponse(request);
      if (cached instanceof Response) return await rangedResponse(request, cached);
    }

    if (request.mode === "navigate" || request.destination === "document") {
      const core = await caches.open(CORE_CACHE);
      const fallback = await core.match(OFFLINE_FALLBACK_URL);
      if (fallback instanceof Response) return fallback.clone();
      return offlineDocumentResponse();
    }
  } catch (_error) {
    // A FetchEvent response must always resolve, including when Cache Storage fails.
  }
  return offlineResourceResponse();
}

function offlineDocumentResponse() {
  return new Response("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Offline</title><h1>You are offline</h1><p>This page was not saved for offline access.</p>", {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function offlineResourceResponse() {
  return new Response("Offline resource is not cached", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response instanceof Response) return response;
  } catch (_error) {}

  try {
    const fallback = await offlineFallback(request);
    if (fallback instanceof Response) return fallback;
  } catch (_error) {}

  return request.mode === "navigate" || request.destination === "document"
    ? offlineDocumentResponse()
    : offlineResourceResponse();
}

self.addEventListener("fetch", function (event) {
  event.respondWith(
    networkFirst(event.request).catch(function () {
      return event.request.mode === "navigate" || event.request.destination === "document"
        ? offlineDocumentResponse()
        : offlineResourceResponse();
    })
  );
});
