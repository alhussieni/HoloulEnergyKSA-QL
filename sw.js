/* HoloulEnergy — Service Worker (مسودة). يخزّن هيكل التطبيق فقط؛ لا يلمس أي طلب لـ Supabase/APIs. */
const V = 'holoul-shell-v1';
const PRECACHE = [
  'home.html', 'login.html', 'crm.html', 'manifest.webmanifest',
  'assets/js/holoul-auth.js', 'assets/js/holoul-offline.js', 'assets/js/site-header.js',
  'assets/js/invoices-report.js', 'assets/js/customer-identity-ui.js', 'assets/js/locale-fix.js',
  'assets/css/header.css', 'assets/css/styles.css', 'assets/css/unified-font.css', 'assets/logo.png'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// شبكة أولًا (فيظهر النشر الجديد فور الاتصال) مع مهلة 4 ثوانٍ ثم النسخة المخزنة — مناسب للتغطية الضعيفة
function networkFirst(req) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      caches.match(req, { ignoreSearch: true }).then((m) => { if (m && !done) { done = true; resolve(m); } });
    }, 4000);
    fetch(req).then((r) => {
      clearTimeout(t);
      if (r && r.ok) { const cp = r.clone(); caches.open(V).then((c) => c.put(req, cp)); }
      if (!done) { done = true; resolve(r); }
    }).catch(() => {
      clearTimeout(t);
      caches.match(req, { ignoreSearch: true }).then((m) => { if (!done) { done = true; resolve(m || Response.error()); } });
    });
  });
}
function cacheFirst(req) {
  return caches.match(req).then((m) => m || fetch(req).then((r) => {
    if (r && r.ok) { const cp = r.clone(); caches.open(V).then((c) => c.put(req, cp)); }
    return r;
  }));
}
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;   // لا تدخّل في Supabase ولا أي نطاق خارجي
  if (/\.(png|jpe?g|webp|gif|svg|ico)$/i.test(url.pathname)) { e.respondWith(cacheFirst(req)); return; }
  e.respondWith(networkFirst(req));
});
