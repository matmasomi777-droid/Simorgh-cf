/* ═══════════════════════════════════════════════════════════════════════════
 *  تستِ سازگاریِ لینکِ اشتراک با Xray/v2rayNِ امروز
 *  ───────────────────────────────────────────────────────────────────────────
 *  چرا لازم بود: پنل تنظیماتی داشت (Early Data، ALPN، ECH) که در قالب‌های
 *  JSON/YAML اعمال می‌شد ولی در لینکِ vless:// / trojan:// — یعنی همان چیزی
 *  که ۹۹٪ کاربران موبایل وارد می‌کنند — بی‌اثر بود. هم‌چنین lینک بدونِ
 *  alpn ساخته می‌شد و کلاینت می‌توانست در TLS روی h2 مذاکره کند، که
 *  وب‌سوکتِ لبه‌ی کلاودفلر را می‌شکند.
 *
 *  این تست از مسیرِ واقعیِ ساب (HTTP) لینک را می‌گیرد و پارامترهای الزامیِ
 *  Xray را می‌سنجد؛ هیچ تابعِ داخلی را مستقیم صدا نمی‌زند تا اگر روزی
 *  بازسازی شد، تست همچنان معنی داشته باشد.
 *
 *  اجرا:  node tests-manual/sub-uri-compat.cjs
 *         node tests-manual/sub-uri-compat.cjs _worker.obf.js
 * ═══════════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, '.suburi-tmp');
const TARGET = process.argv[2] || 'worker.js';

let fail = 0, pass = 0;
const ok = (c, label, extra) => {
  console.log((c ? '  \u2713 ' : '  \u2717 ') + label + (extra !== undefined && extra !== '' ? '  \u2192 ' + extra : ''));
  if (c) pass++; else fail++;
};

globalThis.WebSocketPair = class { constructor() { this[0] = {}; this[1] = {}; } };
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
/* هیچ اتصالِ شبکه‌ای واقعی: پروبِ آی‌پی‌ها و geojs باید بی‌صدا شکست بخورند */
globalThis.fetch = async () => new Response('offline', { status: 404 });
const ctx = { waitUntil() {}, passThroughFunction() {} };

function makeD1() {
  const db = new DatabaseSync(':memory:');
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number((r && r.changes) || 0) } }; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async (col) => { const row = db.prepare(sql).get(...args); if (!row) return null; return col ? (row[col] === undefined ? null : row[col]) : row; },
  });
  return {
    prepare: (sql) => mk(sql, []),
    batch: async (ss) => { const o = []; for (const s of ss) o.push(await s.run()); return o; },
    exec: async (sql) => { db.exec(sql); return { count: 0 }; },
  };
}
const SOCKETS_STUB = `
export const connect = () => ({
  readable: new ReadableStream({ start() {} }),
  writable: new WritableStream({ write() {} }),
  opened: Promise.reject(new Error('offline')),
  closed: new Promise(() => {}),
  close() {}, startTls() { return this; },
});
`;
function prepareDir(srcText) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const body = srcText.replace(/from\s*(['"])((?:\\x[0-9a-fA-F]{2}|\\.|[^'"])*)\1/, (m, q, raw) => {
    const spec = raw.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return spec === 'cloudflare:sockets' ? 'from "./sockets.mjs"' : m;
  });
  fs.writeFileSync(path.join(TMP, 'w.mjs'), body);
  fs.writeFileSync(path.join(TMP, 'sockets.mjs'), SOCKETS_STUB);
  fs.writeFileSync(path.join(TMP, 'package.json'), '{ "type": "module" }\n');
  return 'file:///' + path.join(TMP, 'w.mjs').replace(/\\/g, '/');
}

/* پارامترهای یک URI را به شیء تبدیل می‌کند */
const qOf = (uri) => {
  const s = String(uri).split('#')[0];
  const i = s.indexOf('?');
  const out = {};
  if (i < 0) return out;
  new URLSearchParams(s.slice(i + 1)).forEach((v, k) => { out[k] = v; });
  return out;
};

(async () => {
  const srcPath = path.join(ROOT, TARGET);
  if (!fs.existsSync(srcPath)) { console.error('FATAL: ' + TARGET + ' پیدا نشد'); process.exit(1); }
  const mod = await import(prepareDir(fs.readFileSync(srcPath, 'utf8')));
  const handler = mod.default;
  const env = { DB: makeD1() };

  const call = async (pathname, opts = {}) => {
    const req = new Request('https://panel.test' + pathname, {
      method: opts.method || 'GET',
      headers: Object.assign({ 'cf-connecting-ip': '203.0.113.7' }, opts.headers || {}),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    return handler.fetch(req, env, ctx);
  };

  /* ورود + تنظیماتِ دلخواه */
  const login = await (await call('/api/login', { method: 'POST', body: { password: 'simorgh' }, headers: { 'content-type': 'application/json' } })).json();
  const token = login.token;
  ok(!!token, 'ورود به پنل');

  const auth = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const save = await call('/api/settings', {
    method: 'PUT', headers: auth,
    body: {
      settings: {
        tls: true, sni: 'cdn.example.com', host: 'cdn.example.com', alpn: 'http/1.1',
        fingerprint: 'chrome', earlyData: true, path: '/sg',
        ech: { enabled: true, mode: 'doh' },
        cleanIPs: ['104.17.152.10#فرانکفورت'], ports: [443], mode: 'both',
        protocols: { vless: true, trojan: true, ss: false, vmess: false },
        sub: { path: 'sub', nodeLimit: 4, fakeConfigs: false, namePattern: '{node}:{port}' },
      },
    },
  });
  ok(save.status === 200 || save.status === 204, 'ذخیرهٔ تنظیمات', 'status=' + save.status);

  const st = await (await call('/api/state', { headers: auth })).json();
  const user = (st.users || [])[0];
  ok(!!(user && user.uuid), 'کاربر موجود است');

  const sub = await call('/sub/' + user.uuid + '?format=raw');
  const body = await sub.text();
  ok(sub.status === 200, 'ساب با format=raw سرو شد', 'status=' + sub.status);
  const lines = body.split('\n').filter(Boolean);
  ok(lines.length > 0, 'حداقل یک کانفیگ', 'n=' + lines.length);

  const vless = lines.find((l) => l.startsWith('vless://'));
  const trojan = lines.find((l) => l.startsWith('trojan://'));
  ok(!!vless, 'لینک VLESS ساخته شد');
  ok(!!trojan, 'لینک Trojan ساخته شد');

  const vq = qOf(vless);
  /* ── پارامترهای الزامیِ Xray برای VLESS ── */
  ok(vq.encryption === 'none', 'VLESS: encryption=none (الزامی از Xray 24.9 به بعد)', vq.encryption);
  ok(vq.security === 'tls', 'VLESS: security=tls', vq.security);
  ok(vq.type === 'ws', 'VLESS: type=ws', vq.type);
  ok(vq.sni === 'cdn.example.com', 'VLESS: sni از تنظیمات', vq.sni);
  ok(vq.host === 'cdn.example.com', 'VLESS: host برای هدرِ Host', vq.host);
  ok(vq.fp === 'chrome', 'VLESS: fp=chrome', vq.fp);
  ok(vq.alpn === 'http/1.1', 'VLESS: alpn=http/1.1 (بدونِ آن، ws روی h2 می‌شکند)', vq.alpn);
  ok(vq.ech === 'true', 'VLESS: ech=true وقتی در پنل روشن است', vq.ech);
  ok(/ed=2048/.test(vq.path || ''), 'VLESS: early-data در path (تنظیمِ پنل بی‌اثر نبود)', vq.path);
  ok(!/h2/.test(vq.alpn || ''), 'VLESS: alpn هرگز h2 نیست');

  const tq = qOf(trojan);
  ok(tq.security === 'tls', 'Trojan: security=tls', tq.security);
  ok(tq.type === 'ws', 'Trojan: type=ws', tq.type);
  ok(tq.alpn === 'http/1.1', 'Trojan: alpn=http/1.1', tq.alpn);
  ok(/ed=2048/.test(tq.path || ''), 'Trojan: early-data در path', tq.path);
  ok(!('encryption' in tq), 'Trojan: پارامتر encryption ندارد (فقط مخصوصِ VLESS)');

  /* ── earlyData خاموش → ed نباید باشد ── */
  await call('/api/settings', {
    method: 'PUT', headers: auth,
    body: { settings: { earlyData: false, ech: { enabled: false } } },
  });
  const body2 = await (await call('/sub/' + user.uuid + '?format=raw')).text();
  const v2 = qOf(body2.split('\n').find((l) => l.startsWith('vless://')));
  ok(!/ed=2048/.test(v2.path || ''), 'earlyData خاموش → بدونِ ed در path', v2.path);
  ok(!v2.ech, 'ech خاموش → بدونِ پارامتر ech');

  /* ── قالب‌های JSON هم باید معتبر بمانند ── */
  for (const f of ['clash', 'singbox', 'v2ray']) {
    const r = await call('/sub/' + user.uuid + '?format=' + f);
    const t = await r.text();
    let parsed = null;
    try {
      parsed = f === 'clash' ? t : JSON.parse(t);
    } catch (e) { parsed = null; }
    ok(r.status === 200 && !!parsed, 'قالب ' + f + ' معتبر است', 'status=' + r.status);
  }

  console.log('\n' + (fail ? fail + ' تست ناموفق ✗' : 'ALL ' + pass + ' SUB-URI TESTS PASSED ✓'));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(1); });
