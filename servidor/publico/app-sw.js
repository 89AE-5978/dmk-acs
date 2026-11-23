/* DMK Wi-Fi - service worker mínimo: deixa o app instalável e abre a tela mesmo com internet ruim.
   Só guarda a "casca" (tela, estilo, scripts). Dados (/api/) sempre vão direto ao servidor. */
'use strict';
const CACHE = 'dmk-wifi-v2';
const CASCA = ['./', '../assets/estilo.css', '../assets/base.js', '../assets/app.js', '../assets/tema.js', '../assets/icone-app.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CASCA)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.includes('/api/')) return;   // dados: sempre na rede
  // Rede primeiro (pega versão nova); sem rede, usa a cópia guardada
  e.respondWith(fetch(e.request).then((r) => { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); return r; }).catch(() => caches.match(e.request)));
});
