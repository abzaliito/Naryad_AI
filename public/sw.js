const CACHE = 'naryad-shell-v3';
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const shell = await fetch('/', {cache:'reload'});
    const html = await shell.clone().text();
    await cache.put('/',shell);
    const assets=[...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match=>match[1]))];
    await cache.addAll(['/icon.svg','/icon-192.png','/icon-512.png','/manifest.webmanifest',...assets]);
  })());
  self.skipWaiting();
});
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api') || url.pathname.startsWith('/uploads') || url.pathname.includes('/@') || url.pathname.startsWith('/src')) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const clone = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, clone)); }
    return response;
  }).catch(() => caches.match(event.request).then(hit => hit || (event.request.mode === 'navigate' ? caches.match('/') : new Response('', {status:503})))));
});
self.addEventListener('push', event => {
  let data = {title:'НарядAI'};
  try { data = {...data, ...event.data.json()}; } catch {}
  event.waitUntil(self.registration.showNotification(data.title, {body:data.message || data.body || 'Обновление по вашему наряду',icon:'/icon-192.png',badge:'/icon-192.png',tag:data.id || data.orderId || 'naryad',data:{orderId:data.orderId},vibrate:[250,100,250],requireInteraction:data.kind==='danger'||data.urgent===true}));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.orderId ? `/?order=${encodeURIComponent(event.notification.data.orderId)}` : '/';
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients => {
    if (clients.length) { await clients[0].navigate(target); return clients[0].focus(); }
    return self.clients.openWindow(target);
  }));
});
