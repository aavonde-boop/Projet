/* Service worker : rend l'appli installable et la fait démarrer même sans réseau.
   Stratégie « réseau d'abord » pour la page : chaque mise à jour publiée sur
   GitHub est visible immédiatement ; le cache ne sert que hors connexion.
   Les appels externes (Supabase, emails, notifications) ne sont jamais mis en cache. */
const CACHE = 'commandes-v42';
const SHELL = ['./', './index.html', './manifest.webmanifest', './express.html', './express.webmanifest', './ic3-180.png', './ic3-192.png', './ic3-512.png', './favicon.svg', './favicon.ico'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase, CDN, ntfy… : réseau direct
  if (/\.(png|ico|svg|webmanifest)$/.test(url.pathname)) return; // icônes et manifeste : toujours en direct (iPhone)

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
