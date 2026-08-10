/* Plazacore service worker — app-shell cache + offline fallback.
 * Strategy:
 *  - index.html / navigations: NETWORK-FIRST, cache only as offline fallback.
 *    The whole app (all JS) lives inside index.html, so stale-while-revalidate
 *    served users a one-deploy-old application: a fix could be live on the
 *    server while the browser still ran the previous build until a second
 *    reload. That produced a real false alarm on 2026-08-10 — CO-3 reported
 *    "No SOV match" from cached pre-fix code after the fix was already live.
 *    Correctness of billing logic beats a few hundred ms of load time.
 *  - Static assets (manifest, icons) + pdf.js / supabase-js CDN libs:
 *    cache-first with background refresh (stale-while-revalidate). These are
 *    immutable-ish and safe to serve stale.
 *  - Supabase REST / auth / storage / functions: NEVER cached or intercepted.
 *    Writes that fail offline are queued by the app in IndexedDB (see app code),
 *    not by the SW. Reads simply fail and the app shows cached DATA.
 */
const CACHE = 'plazacore-shell-v32';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];
// CDN libs the app needs to function (pdf.js, supabase-js esm).
const RUNTIME_ALLOW = [
  'https://cdn.jsdelivr.net/npm/pdfjs-dist',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isSupabaseApi(url) {
  // Never intercept the data plane — let the app + outbox handle connectivity.
  return url.includes('.supabase.co/rest/') ||
         url.includes('.supabase.co/auth/') ||
         url.includes('.supabase.co/storage/') ||
         url.includes('.supabase.co/functions/') ||
         url.includes('.supabase.co/realtime/');
}

// The application code IS index.html — it must never be served stale.
function isAppShellDoc(req, url) {
  if (req.mode === 'navigate') return true;
  if (req.destination === 'document') return true;
  const path = url.startsWith(self.location.origin)
    ? url.slice(self.location.origin.length).split('?')[0]
    : '';
  return path === '/' || path === '/index.html';
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // writes pass straight through
  const url = req.url;
  if (isSupabaseApi(url)) return;                   // data plane: no SW involvement

  // ---- index.html + SPA navigations: NETWORK-FIRST -------------------------
  // Always try the network so a deployed fix takes effect on the very next
  // reload. Cache is refreshed on success and used only when offline.
  if (isAppShellDoc(req, url)) {
    e.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  const sameOrigin = url.startsWith(self.location.origin);
  const allowedCdn = RUNTIME_ALLOW.some((p) => url.startsWith(p));
  if (!sameOrigin && !allowedCdn) return;           // ignore other cross-origin

  // Stale-while-revalidate for shell + allowed CDN libs.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

// Allow the app to trigger an immediate activation after an update.
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
