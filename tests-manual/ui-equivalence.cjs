/* مقایسهٔ خروجیِ پنل بین worker.js و _worker.obf.js — ماسکِ AST نباید یک بایت را عوض کند */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, '.uieq-tmp');
const UI = {
  html: fs.readFileSync(path.join(ROOT, 'ui/index.html'), 'utf8'),
  css: fs.readFileSync(path.join(ROOT, 'ui/style.css'), 'utf8'),
  js: fs.readFileSync(path.join(ROOT, 'ui/app.js'), 'utf8'),
  user: fs.readFileSync(path.join(ROOT, 'new-subscription.html'), 'utf8'),
};

globalThis.WebSocketPair = class { constructor() { this[0] = {}; this[1] = {}; } };
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
/* fetch قلابی: فایل‌های UI را از دیسک می‌دهد تا loadUI واقعی اجرا شود */
globalThis.fetch = async (u) => {
  const s = String(u);
  if (/index\.html/.test(s)) return new Response(UI.html, { status: 200, headers: { etag: '"h"' } });
  if (/style\.css/.test(s)) return new Response(UI.css, { status: 200, headers: { etag: '"c"' } });
  if (/app\.js/.test(s)) return new Response(UI.js, { status: 200, headers: { etag: '"j"' } });
  if (/new-subscription/.test(s)) return new Response(UI.user, { status: 200, headers: { etag: '"u"' } });
  if (/user\.html/.test(s)) return new Response('', { status: 404 });
  return new Response('offline', { status: 404 });
};
const ctx = { waitUntil() {}, passThroughFunction() {} };

function makeD1() {
  const db = new DatabaseSync(':memory:');
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    run: async () => { db.prepare(sql).run(...args); return { success: true, meta: { changes: 1 } }; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async (col) => { const r = db.prepare(sql).get(...args); if (!r) return null; return col ? (r[col] === undefined ? null : r[col]) : r; },
  });
  return { prepare: (sql) => mk(sql, []), batch: async (ss) => { for (const s of ss) await s.run(); return []; }, exec: async (s) => { db.exec(s); } };
}
const STUB = `export const connect = () => ({ readable: new ReadableStream({ start() {} }), writable: new WritableStream({ write() {} }), opened: Promise.resolve(), closed: new Promise(() => {}), close() {}, startTls() { return this; } });`;
function prepare(name) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const body = fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/from\s*(['"])cloudflare:sockets\1/, 'from "./sockets.mjs"');
  fs.writeFileSync(path.join(TMP, 'w.mjs'), body);
  fs.writeFileSync(path.join(TMP, 'sockets.mjs'), STUB);
  fs.writeFileSync(path.join(TMP, 'package.json'), '{ "type": "module" }\n');
  return 'file:///' + path.join(TMP, 'w.mjs').replace(/\\/g, '/');
}

(async () => {
  const out = {};
  for (const f of ['worker.js', '_worker.obf.js']) {
    const mod = await import(prepare(f));
    const env = { DB: makeD1() };
    const res = await mod.default.fetch(new Request('https://panel.test/panel', { headers: { 'cf-connecting-ip': '203.0.113.9' } }), env, ctx);
    const body = await res.text();
    out[f] = { status: res.status, len: body.length, hash: require('node:crypto').createHash('sha256').update(body).digest('hex').slice(0, 16), body };
  }
  const a = out['worker.js'], b = out['_worker.obf.js'];
  console.log('worker.js        status=' + a.status + ' len=' + a.len + ' sha=' + a.hash);
  console.log('_worker.obf.js   status=' + b.status + ' len=' + b.len + ' sha=' + b.hash);
  if (a.hash === b.hash) console.log('OK — خروجیِ پنل کاملاً یکسان است (ماسک بی‌اثر بود)');
  else {
    console.log('MISMATCH — اولین تفاوت:');
    for (let i = 0; i < Math.max(a.body.length, b.body.length); i++) {
      if (a.body[i] !== b.body[i]) { console.log('  at ' + i + ': ' + JSON.stringify(a.body.slice(Math.max(0, i - 60), i + 60)) + '\n  vs ' + JSON.stringify(b.body.slice(Math.max(0, i - 60), i + 60))); break; }
    }
    process.exitCode = 1;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
})();
