// Global Currency Hub — بدون أي اعتماديات خارجية (Node 18+ فقط).
// المصدر: Frankfurter (بيانات البنك المركزي الأوروبي ECB، تتحدث مرة كل يوم عمل، بدون مفتاح API).
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const SRC = 'https://api.frankfurter.dev/v1';
const PUBLIC = path.join(__dirname, 'public');
const TTL = { rates: 30 * 60e3, hist: 60 * 60e3, list: 24 * 3600e3 };

// ذاكرة مؤقتة: نخدم النسخة القديمة إذا فشل المصدر (stale-on-error)
const cache = new Map();
async function cached(key, ttl, url) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return { ...hit.v, stale: false };
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('upstream ' + r.status);
    const v = { data: await r.json(), fetchedAt: new Date().toISOString() };
    cache.set(key, { t: Date.now(), v });
    return { ...v, stale: false };
  } catch (e) {
    if (hit) return { ...hit.v, stale: true };
    throw e;
  }
}

// حد بسيط للطلبات لكل IP: 120 طلب/دقيقة
const hits = new Map();
setInterval(() => hits.clear(), 60e3).unref();
const limited = ip => { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > 120; };

const isCode = s => /^[A-Z]{3}$/.test(s || '');
const day = d => d.toISOString().slice(0, 10);
const ago = n => day(new Date(Date.now() - n * 864e5));

async function api(u) {
  const q = u.searchParams;
  if (u.pathname === '/api/currencies')
    return cached('list', TTL.list, SRC + '/currencies');
  if (u.pathname === '/api/rates') {           // آخر سعر + السعر السابق لحساب التغير
    const base = (q.get('base') || 'USD').toUpperCase();
    if (!isCode(base)) throw Object.assign(new Error('bad base'), { code: 400 });
    return cached('r' + base, TTL.rates, `${SRC}/${ago(10)}..?base=${base}`);
  }
  if (u.pathname === '/api/history') {
    const base = (q.get('base') || '').toUpperCase(), to = (q.get('quote') || '').toUpperCase();
    const days = Math.min(Math.max(parseInt(q.get('days'), 10) || 30, 2), 366);
    if (!isCode(base) || !isCode(to)) throw Object.assign(new Error('bad code'), { code: 400 });
    return cached(`h${base}${to}${days}`, TTL.hist, `${SRC}/${ago(days)}..?base=${base}&symbols=${to}`);
  }
  throw Object.assign(new Error('not found'), { code: 404 });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const sec = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (req.method !== 'GET') { res.writeHead(405, sec); return res.end(); }
  if (u.pathname.startsWith('/api/')) {
    if (limited(req.socket.remoteAddress)) { res.writeHead(429, sec); return res.end('{"error":"too many requests"}'); }
    try {
      const out = await api(u);
      res.writeHead(200, { ...sec, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(e.code || 502, { ...sec, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.code ? e.message : 'تعذر الوصول إلى مصدر البيانات' }));
    }
    return;
  }
  const file = path.join(PUBLIC, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, sec); return res.end('Not found'); }
    res.writeHead(200, { ...sec, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, () => console.log('Global Currency Hub → http://localhost:' + PORT));
