const CACHE = 'autotrader-v1';
const STATIC = ['./', './index.html', './css/app.css',
  './js/app.js', './js/config.js', './js/events.js',
  './js/indicators.js', './js/strategy.js', './js/risk.js',
  './js/news.js', './js/engine.js', './js/ui.js',
  './js/broker/alpaca.js', './js/broker/saudi.js'];

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC))));

self.addEventListener('activate', e =>
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))));

self.addEventListener('fetch', e => {
  // Never cache API calls
  if (e.request.url.includes('alpaca.markets') ||
      e.request.url.includes('finnhub.io') ||
      e.request.url.includes('alphavantage.co')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
