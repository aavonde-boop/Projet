/* Service worker : rend l'appli installable et la fait démarrer même sans réseau.
   Stratégie « réseau d'abord » pour la page : chaque mise à jour publiée sur
   GitHub est visible immédiatement ; le cache ne sert que hors connexion.
   Les appels externes (Supabase, emails, notifications) ne sont jamais mis en cache. */
const CACHE = 'commandes-v46';
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

// Notifications envoyées par le serveur (même appli fermée)
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Gestion des services', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'Gestion des services';
  e.waitUntil(self.registration.showNotification(title, { body: d.body || '', icon: 'ic3-192.png', badge: 'ic3-192.png', tag: d.tag || 'gestion', renotify: true, data: { url: d.url || './index.html' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './index.html', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
