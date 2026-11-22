/* سنجشِ هزینهٔ «استارتِ isolate»: بارِ ماژول (parse + init) برای worker.js و _worker.obf.js */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, '.loadbench-tmp');
const STUB = `export const connect = () => ({ readable: new ReadableStream({ start() {} }), writable: new WritableStream({ write() {} }), opened: Promise.resolve(), closed: new Promise(() => {}), close() {}, startTls() { return this; } });`;

function prepare(name) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const src = fs.readFileSync(path.join(ROOT, name), 'utf8')
    .replace(/from\s*(['"])cloudflare:sockets\1/, 'from "./sockets.mjs"');
  fs.writeFileSync(path.join(TMP, 'w.mjs'), src);
  fs.writeFileSync(path.join(TMP, 'sockets.mjs'), STUB);
  fs.writeFileSync(path.join(TMP, 'package.json'), '{ "type": "module" }\n');
  return 'file:///' + path.join(TMP, 'w.mjs').replace(/\\/g, '/');
}

const run = (name, rounds) => {
  const url = prepare(name);
  const code = `
    globalThis.WebSocketPair = class { constructor() { this[0] = {}; this[1] = {}; } };
    const t0 = process.cpuUsage(); const w0 = Date.now();
    await import(${JSON.stringify(url)});
    const c = process.cpuUsage(t0);
    console.log(JSON.stringify({ cpu: Math.round((c.user + c.system) / 1000), wall: Date.now() - w0 }));
  `;
  const out = [];
  for (let i = 0; i < rounds; i++) {
    const r = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    out.push(JSON.parse(r.trim().split('\n').pop()));
  }
  const cpu = out.map((x) => x.cpu).sort((a, b) => a - b);
  const wall = out.map((x) => x.wall).sort((a, b) => a - b);
  return { cpu: cpu[Math.floor(cpu.length / 2)], wall: wall[Math.floor(wall.length / 2)] };
};

const N = Number(process.env.ROUNDS || 5);
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['worker.js', '_worker.obf.js'];
for (const f of files) {
  if (!fs.existsSync(path.join(ROOT, f))) continue;
  const r = run(f, N);
  console.log(`${f.padEnd(22)} module load: CPU=${String(r.cpu).padStart(4)}ms  wall=${String(r.wall).padStart(4)}ms   (median of ${N})`);
}
fs.rmSync(TMP, { recursive: true, force: true });
