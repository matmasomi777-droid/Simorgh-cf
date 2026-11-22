/* آزمونِ نشستِ طولانی: تایمرِ ضربانِ اتصال (۱۲ ثانیه) واقعاً اجرا شود */
const http = require('http');
const crypto = require('crypto');

const HOST = '127.0.0.1', PORT = Number(process.env.PORT || 8787);
const get = (p, h) => new Promise((r) => {
  const q = http.request({ host: HOST, port: PORT, path: p, timeout: 15000, headers: h || {} }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => r({ s: res.statusCode, b }));
  });
  q.on('timeout', () => { q.destroy(); r({ s: 0, b: 'timeout' }); });
  q.on('error', (e) => r({ s: 0, b: e.message }));
  q.end();
});
const post = (p, body) => new Promise((r) => {
  const d = JSON.stringify(body);
  const q = http.request({ host: HOST, port: PORT, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} r({ s: res.statusCode, j }); });
  });
  q.on('error', () => r({ s: 0, j: null }));
  q.write(d); q.end();
});

(async () => {
  const login = await post('/api/login', { password: process.env.PANEL_PASS || 'simorgh' });
  const token = login.j && login.j.token;
  const st = await get('/api/state', { authorization: 'Bearer ' + token });
  let uuid = '';
  try { uuid = JSON.parse(st.b).users[0].uuid; } catch (e) {}
  console.log('uuid:', uuid || '(none)');

  /* یک اتصال با UUIDِ معتبر، مقصدِ 443 (مسیرِ httpFallback/fetch) و نگه‌داشتنِ ۴۵ ثانیه */
  const key = crypto.randomBytes(16).toString('base64');
  const req = http.request({
    host: HOST, port: PORT, path: '/', method: 'GET',
    headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', 'cf-connecting-ip': '198.51.100.77' },
  });
  let sock = null;
  req.on('upgrade', (res, s) => {
    sock = s;
    console.log('upgraded:', res.statusCode);
    const uuidBytes = Buffer.from(uuid.replace(/-/g, ''), 'hex');
    const host = 'example.com';
    const hdr = Buffer.concat([
      Buffer.from([0]), uuidBytes, Buffer.from([0, 1, 0x01, 0xbb, 2, host.length]),
      Buffer.from(host), Buffer.from('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'),
    ]);
    const mask = crypto.randomBytes(4);
    const payload = Buffer.alloc(hdr.length);
    for (let i = 0; i < hdr.length; i++) payload[i] = hdr[i] ^ mask[i % 4];
    const head = hdr.length < 126 ? Buffer.from([0x82, 0x80 | hdr.length]) : Buffer.from([0x82, 0x80 | 126, (hdr.length >> 8) & 255, hdr.length & 255]);
    s.write(Buffer.concat([head, mask, payload]));
    console.log('sent vless header, holding 45s…');
  });
  req.on('error', (e) => console.log('upgrade error:', e.message));
  req.end();

  for (let i = 1; i <= 9; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const h = await get('/health');
    console.log(`  +${i * 5}s  /health=${h.s}${h.s === 200 ? '' : '  ← ' + String(h.b).slice(0, 120)}`);
  }
  try { sock && sock.destroy(); } catch (e) {}
  await new Promise((r) => setTimeout(r, 2000));
  const h2 = await get('/health');
  console.log('after close: /health=' + h2.s);
  process.exit(0);
})();
