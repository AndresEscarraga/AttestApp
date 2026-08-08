// Attest — Service Worker for offline caching & PWA
const CACHE_NAME = 'attest-phase1-v3';
const STATIC_ASSETS = [
  '/',
  '/login.html',
  '/dashboard.html',
  '/campaigns.html',
  '/reviews.html',
  '/audit-trail.html',
  '/sod.html',
  '/evidence.html',
  '/data-sources.html',
  '/admin-users.html',
  '/tenants.html',
  '/settings.html',
  '/api-keys.html',
  '/activity.html',
  '/onboarding.html',
  '/offboarding.html',
  '/styles.css',
  '/components.js',
  '/shared.js',
  '/app.js',
  '/sod.js',
  '/mobile.js',
];

// Install — cache all static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

// Fetch — cache-first for static, network-first for API
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Skip non-GET and API calls
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        // Return cached version, update cache in background
        fetch(event.request).then(res => {
          if (res.ok) caches.open(CACHE_NAME).then(cache => cache.put(event.request, res));
        }).catch(error => console.warn('Background cache refresh failed:', error));
        return cached;
      }
      return fetch(event.request).then(res => {
        if (!res || !res.ok || res.type !== 'basic') return res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return res;
      }).catch(() => {
        // Offline fallback for HTML pages
        if (event.request.headers.get('accept').includes('text/html')) {
          return caches.match('/login.html');
        }
      });
    })
  );
});
