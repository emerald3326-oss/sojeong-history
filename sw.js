/* 앱 설치용 서비스 워커: 항상 새 파일을 먼저 받아 보고, 인터넷이 안 될 때만 저장해 둔 파일을 씁니다. */
const CACHE = 'sj-__BUILD__';
const CORE = ['./', 'index.html', 'plan-data.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-64.png',
  'fonts/cheonsaeng-yeonbun.woff2', 'fonts/omyu-pretty.woff2', 'fonts/hu-summersea.woff2', 'fonts/sejong-geulggot.woff2'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return Promise.all(CORE.map(function (u) { return c.add(u).catch(function () {}); })); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.endsWith('version.json')) return;
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (r) { return r || (req.mode === 'navigate' ? caches.match('index.html') : undefined); });
    })
  );
});
