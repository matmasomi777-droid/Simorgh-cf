/* ═══════════════════════════════════════════════════════════════════════════
 *  آزمونِ ۱۱۰۱ در runtime واقعیِ کلاودفلر (workerd از طریق wrangler dev)
 *  ───────────────────────────────────────────────────────────────────────────
 *  سناریوهایی که در تولید ۱۱۰۱ می‌دادند:
 *    ۱) اتصالِ وب‌سوکتِ تونل که کلاینت ناگهانی قطعش می‌کند
 *    ۲) همان اتصال + عبورِ داده (تا مسیرِ شمارش/تمدد فعال شود)
 *    ۳) درخواست‌های سادهٔ پنل/ساب/استتار
 *  بعد از هر سناریو، چند ثانیه صبر می‌کنیم (بیشتر از CONN_KEEPALIVE_MS) و
 *  دوباره /health می‌زنیم: اگر isolate مرده باشد، پاسخ خطا/غیرِ ۲۰۰ می‌شود.
 *
 *  اجرا:  node tests-manual/workerd-1101.cjs [base]
 * ═══════════════════════════════════════════════════════════════════════════ */
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const HOST = BASE.replace(/^https?:\/\//, '').split(':')[0];
const PORT = Number(BASE.split(':').pop()) || 8787;

let fail = 0;
const ok = (c, label, extra) => {
  console.log((c ? '  ✓ ' : '  ✗ ') + label + (extra ? '  → ' + extra : ''));
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = (path, headers) => new Promise((resolve) => {
  const req = http.request({ host: HOST, port: PORT, path, method: 'GET', timeout: 15000, headers: headers || {} }, (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
  req.end();
});

const post = (path, body, headers = {}) => new Promise((resolve) => {
  const data = JSON.stringify(body);
  const req = http.request({
    host: HOST, port: PORT, path, method: 'POST', timeout: 20000,
    headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, headers),
  }, (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, body: b, j }); });
  });
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
  req.write(data);
  req.end();
});

/* ── حداقلِ کلاینتِ WebSocket: ارتقا + یک فریمِ دودویی + بستن ── */
function wsProbe({ sendVless, holdMs, closeHard, uuid: fixedUuid }) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: HOST, port: PORT, path: '/', method: 'GET',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        'cf-connecting-ip': '198.51.100.' + (1 + Math.floor(Math.random() * 200)),
      },
    });
    let upgraded = false;
    req.on('upgrade', (res, socket) => {
      upgraded = res.statusCode === 101;
      const mask = crypto.randomBytes(4);
      const send = (payload) => {
        const p = Buffer.from(payload);
        const len = p.length;
        let head;
        if (len < 126) head = Buffer.from([0x82, 0x80 | len]);
        else head = Buffer.from([0x82, 0x80 | 126, (len >> 8) & 255, len & 255]);
        const masked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) masked[i] = p[i] ^ mask[i % 4];
        try { socket.write(Buffer.concat([head, mask, masked])); } catch (e) {}
      };
      if (sendVless) {
        /* هدر VLESS — با UUIDِ معتبر (اگر داده شد) یا تصادفی */
        const uuid = fixedUuid ? Buffer.from(String(fixedUuid).replace(/-/g, ''), 'hex') : crypto.randomBytes(16);
        const hdr = Buffer.concat([
          Buffer.from([0]), uuid, Buffer.from([0, 1, 0x01, 0xbb, 2, 11]),
          Buffer.from('example.com'), Buffer.from('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n'),
        ]);
        send(hdr);
      }
      setTimeout(() => {
        if (closeHard) { try { socket.destroy(); } catch (e) {} }
        else { try { socket.end(); } catch (e) {} }
        resolve({ upgraded });
      }, holdMs);
    });
    req.on('error', (e) => resolve({ upgraded: false, err: String(e.message) }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ upgraded: false, err: 'timeout' }); });
    req.end();
  });
}

(async () => {
  console.log('هدف: ' + BASE + '\n');

  /* ۰) سالم بودنِ اولیه */
  const h0 = await get('/health');
  ok(h0.status === 200, 'شروع: /health سالم است', 'status=' + h0.status);
  let storage = '';
  try { storage = JSON.parse(h0.body).storage; } catch (e) {}
  console.log('    بک‌اندِ ذخیره‌سازی: ' + (storage || '?'));

  /* ۰٫۵) ورود + UUIDِ واقعیِ کاربر (تا مسیرِ D1/سهمیه/شمارش هم طی شود) */
  const login = await post('/api/login', { password: process.env.PANEL_PASS || 'simorgh' });
  const token = login.j && login.j.token;
  ok(!!token, 'ورود به پنل', 'status=' + login.status);
  let uuid = '';
  if (token) {
    const stt = await get('/api/state', { authorization: 'Bearer ' + token });
    if (stt.status === 200) {
      try { uuid = (JSON.parse(stt.body).users[0] || {}).uuid || ''; } catch (e) {}
    }
    ok(!!uuid, 'UUIDِ کاربر خوانده شد', uuid || '—');
  }

  /* ۱) مسیرهای ساده */
  for (const p of ['/', '/panel', '/sub/deadbeef', '/api/state', '/nope-' + Date.now(), '/dns-query?name=example.com&type=A']) {
    const r = await get(p);
    ok(r.status > 0 && r.status < 500, 'GET ' + p + ' پاسخ داد (نه ۵۰۰/۱۱۰۱)', 'status=' + r.status);
  }

  /* ۲) وب‌سوکت: ارتقا + بستنِ نرم */
  const w1 = await wsProbe({ sendVless: false, holdMs: 300 });
  ok(w1.upgraded, 'وب‌سوکت ارتقا یافت', w1.err || '101');

  /* ۳) وب‌سوکت: هدر VLESS + قطعِ ناگهانی (RST) — همان الگوی «کلاینت رفت» */
  const w2 = await wsProbe({ sendVless: true, holdMs: 500, closeHard: true });
  ok(w2.upgraded, 'وب‌سوکت با ترافیکِ VLESS ارتقا یافت', w2.err || '101');

  /* ۳٫۵) وب‌سوکت با UUIDِ معتبر — مسیرِ کاملِ dial: سهمیه، D1، connect()، شمارش */
  if (uuid) {
    const w3 = await wsProbe({ sendVless: true, holdMs: 1500, closeHard: true, uuid });
    ok(w3.upgraded, 'وب‌سوکت با UUIDِ معتبر (مسیرِ dial کامل)', w3.err || '101');
    await sleep(1200);
  }

  /* ۴) انتظارِ بیشتر از CONN_KEEPALIVE_MS — تایمرِ ضربان باید بی‌خطر باشد */
  console.log('\n  … ۱۶ ثانیه انتظار (بیشتر از ضربانِ ۱۲ ثانیه‌ای) …');
  await sleep(16000);

  const h1 = await get('/health');
  ok(h1.status === 200, 'بعد از تایمر: /health هنوز سالم است', 'status=' + h1.status);

  /* ۵) موجِ درخواست‌های هم‌زمان — فشار روی state/D1 و isolate */
  const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => get(i % 2 ? '/health' : '/api/state')));
  const bad = burst.filter((r) => r.status === 0 || r.status >= 500);
  ok(bad.length === 0, '۲۰ درخواستِ هم‌زمان همه پاسخ دادند', bad.length ? JSON.stringify(bad[0]).slice(0, 120) : 'بدونِ خطا');

  /* ۶) دوباره پس از موج */
  const h2 = await get('/health');
  ok(h2.status === 200, 'بعد از موج: /health سالم است', 'status=' + h2.status);

  /* ۷) ساب با UUIDِ واقعی — مسیرِ buildList/پروب/تولیدِ لینک */
  if (uuid) {
    const sub = await get('/sub/' + uuid + '?format=raw');
    ok(sub.status === 200 && /vless:\/\//.test(sub.body), 'سابِ واقعی ساخته شد', 'status=' + sub.status + ' • ' + sub.body.split('\n').length + ' خط');
  }

  /* ۸) ورودی‌های خراب — هیچ‌کدام نباید isolate را بکشد */
  const junk = [
    ['POST', '/api/login', '{"password":', {}],                       // JSON ناقص
    ['POST', '/api/login', 'not-json-at-all', {}],
    ['POST', '/api/users', '{"name":"x"}', { authorization: 'Bearer garbage' }],
    ['POST', '/api/action', '{"act":"' + 'x'.repeat(2000) + '"}', { authorization: 'Bearer garbage' }],
    ['GET', '/api/state', null, { authorization: 'Bearer ' + 'a'.repeat(5000) }],
    ['GET', '/' + 'a'.repeat(3000), null, {}],
    ['GET', '/sub/' + (uuid || 'x') + '?format=%00%ff', null, {}],
    ['GET', '/health?x=' + 'y'.repeat(2000), null, {}],
  ];
  for (const [method, path, body, headers] of junk) {
    const r = await new Promise((resolve) => {
      const q = http.request({ host: HOST, port: PORT, path, method, timeout: 15000, headers: Object.assign({ 'content-type': 'application/json' }, headers) }, (res) => {
        let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ s: res.statusCode }));
      });
      q.on('error', (e) => resolve({ s: 0, e: e.message }));
      q.on('timeout', () => { q.destroy(); resolve({ s: 0, e: 'timeout' }); });
      if (body) q.write(body);
      q.end();
    });
    ok(r.s > 0 && r.s < 500, 'ورودیِ خراب: ' + method + ' ' + path.slice(0, 40) + ' → پاسخِ مهارشده', 'status=' + r.s + (r.e ? ' ' + r.e : ''));
  }

  /* ۹) سلامتِ نهایی + گزارشِ خطاهای مهارشده */
  const hEnd = await get('/health');
  let diag = {};
  try { diag = JSON.parse(hEnd.body); } catch (e) {}
  ok(hEnd.status === 200, 'پایان: /health سالم است', 'status=' + hEnd.status);
  console.log('    خطاهای مهارشده: ' + (diag.errors || 0) + (diag.lastError ? ' • آخرین: ' + diag.lastError.where + ' — ' + String(diag.lastError.msg).slice(0, 120) : ''));

  console.log('\n' + (fail ? fail + ' مورد شکست ✗' : 'همه سالم — هیچ ۱۱۰۱ ای مشاهده نشد ✓'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(1); });
