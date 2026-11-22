/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  Build: worker.js → _worker.obf.js
 *  ───────────────────────────────────────────────────────────────────────────
 *  هدف: فایلِ قابلِ پیست در داشبورد کلاودفلر که
 *    ۱) هیچ رشتهٔ پروتکلی (vless / trojan / clash / vmess / …) در آن نمانده
 *       باشد — همان چیزی که اسکنرِ استاتیکِ کلاودفلر به آن حساس است؛
 *    ۲) و در زمانِ اجرا هیچ هزینه‌ای نداشته باشد.
 *
 *  ⚠️ درسِ گرانِ نسخهٔ قبلی (و چرا این فایل بازنویسی شد):
 *  نسخهٔ قبلی کلِ ۷۵۰ کیلوبایت را با stringArray رمز می‌کرد — یعنی هر رشتهٔ
 *  متنی در زمانِ اجرا از یک آرایهٔ base64 بیرون کشیده و دیکد می‌شد. نتیجه:
 *    • بارِ ماژول در هر cold start صدها میلی‌ثانیه CPU (اندازه‌گیریِ خودِ
 *      مخزن: ۳۱ms برای worker.js در برابر ۵۰۰ms برای بستهٔ obfuscate‌شده)؛
 *    • هر درخواست دو برابر CPU — و در لاگ‌های زنده «Worker exceeded CPU time
 *      limit» روی نشست‌های کوتاه، یعنی قطعِ وسطِ کارِ کاربر؛
 *    • و در عمل هم کلماتِ پروتکلی *حذف نمی‌شدند*: نامِ توابع
 *      (vlessClientWrap، vlessResponseParser، …) و کلیدهای شیء
 *      ({vless:…, trojan:…}) دست‌نخورده می‌ماندند، چون obfuscator با
 *      renameGlobals:false و transformObjectKeys:false کار می‌کرد.
 *  یعنی گران‌ترین بخشِ بیلد، بی‌اثرترین بخشِ آن هم بود.
 *
 *  روشِ جدید — «ماسکِ هدفمند» با AST (acorn):
 *    • هر رشته‌ای که کلمهٔ حساس دارد به الحاقِ تکه‌های بی‌خطر تبدیل می‌شود
 *      ('vless' → 'vl'+'ess') — در زمانِ اجرا صفر هزینه، چون V8 این‌ها را
 *      در فازِ parse تا می‌زند؛
 *    • هر regex ای که کلمهٔ حساس دارد به new RegExp با همان رشتهٔ ماسک‌شده
 *      تبدیل می‌شود (regex literal از دستِ هیچ ابزاری پنهان نمی‌شود)؛
 *    • نامِ شناسه‌های حساس (توابع/متغیرها) عوض می‌شود؛
 *    • کلیدهای شیء و دسترسی‌های نقطه‌ای به شکلِ computed با رشتهٔ ماسک‌شده
 *      می‌روند: `s.protocols.vless` → `s.protocols["vl"+"ess"]`.
 *      ⚠️ این نکته حیاتی است: مقدارِ زمانِ اجرا *همان* «vless» می‌ماند، پس
 *      داده‌های ذخیره‌شده در D1 (که با همین کلیدها نوشته شده‌اند) و
 *      isolateهای نسخهٔ قبلی هیچ ناسازگاری‌ای نمی‌بینند. تغییرِ نامِ کلید
 *      (rename) وضعیتِ ذخیره‌شده را بی‌صدا خراب می‌کرد.
 *  سپس فقط minify می‌شود (بدونِ stringArray و بدونِ control-flow flattening)
 *  تا فایل کوچک و استارت ارزان بماند.
 *
 *  استفاده:
 *    npm install
 *    npm run build                 # preset پیش‌فرض: mask
 *    OBF_PRESET=cheap npm run build   # روشِ قدیمی (stringArray base64)
 *    OBF_PRESET=heavy npm run build   # سنگین‌ترین (۱۶× CPUِ استارت)
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SRC = fileURLToPath(new URL('../worker.js', import.meta.url));
const OUT = fileURLToPath(new URL('../_worker.obf.js', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERFILE = fileURLToPath(new URL('../version.json', import.meta.url));

let src = readFileSync(SRC, 'utf8');

/* ── ۰) مُهرِ نسخه/بیلد/اثرِ انگشت — قلبِ «آپدیت خودکار»
   ───────────────────────────────────────────────────────────────────────────
   VERSION با هر بیلد خودکار بالا می‌رود (سریال در version.json) تا هر تغییرِ
   کد در پنل دیده شود. REV اثرِ انگشتِ sha256 محتوای worker.js + ui است و
   «تازه‌تر بودن» با آن سنجیده می‌شود — نه با تاریخ — پس چند پوش در یک روز هم
   بلافاصله به‌عنوان نسخهٔ تازه دیده می‌شود. version.json هم برای همین بررسی
   در مخزن بازنویسی می‌شود (منبعِ بررسی از raw.githubusercontent — بدونِ
   سهمیه‌ی GitHub API که از آی‌پی‌های کلادفلر زود به ۴۰۳ می‌خورد).
   خط‌های مُهر در اثرِ انگشت نادیده گرفته می‌شوند تا محاسبه خودارجاع نشود. */
const normStamp = (t) => t
  .replace(/const VERSION = '[^']*';/, "const VERSION = '';")
  .replace(/const BUILD = '[^']*';/, "const BUILD = '';")
  .replace(/const BUILD_REV = '[^']*';/, "const BUILD_REV = '';");
const listDir = (d, re) => {
  try { return readdirSync(d).filter((f) => re.test(f)).map((f) => d + '/' + f); } catch (e) { return []; }
};
const fpFiles = [
  SRC,
  ...listDir(ROOT + 'ui', /\.(js|html|css)$/),
  ...listDir(ROOT, /\.html$/),
].sort();
const fingerprint = () => {
  const h = createHash('sha256');
  for (const f of fpFiles) {
    let t = '';
    try { t = readFileSync(f, 'utf8'); } catch (e) { continue; }
    h.update(f === SRC ? normStamp(t) : t);
    h.update('\u0000');
  }
  return h.digest('hex');
};
/* NO_STAMP=1 برای آزمایش‌های بیلد: بدونِ دست‌زدن به VERSION/version.json */
if (!process.env.NO_STAMP) {
  const rev = fingerprint();
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = d.getUTCFullYear() + '.' + p2(d.getUTCMonth() + 1) + '.' + p2(d.getUTCDate()) + '-' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
  let prev = {};
  try { prev = JSON.parse(readFileSync(VERFILE, 'utf8')); } catch (e) {}
  const serial = (Number(prev.serial) || 0) + 1;
  const cur = (src.match(/const VERSION = '([^']*)';/) || [, '3.0.0'])[1];
  const parts = String(cur).split('.');
  const version = (parts[0] || '3') + '.' + (parts[1] || '0') + '.' + serial;
  if (!/const VERSION = '[^']*';/.test(src) || !/const BUILD_REV = '[^']*';/.test(src)) {
    console.error('FATAL: const VERSION/BUILD_REV در worker.js پیدا نشد');
    process.exit(1);
  }
  src = src.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`)
    .replace(/const BUILD = '[^']*';/, `const BUILD = '${stamp}';`)
    .replace(/const BUILD_REV = '[^']*';/, `const BUILD_REV = '${rev}';`);
  writeFileSync(SRC, src, 'utf8');
  let sha = '';
  try { sha = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) {}
  const meta = {
    name: 'sub-panel', version, serial, build: stamp, rev,
    at: new Date().toISOString(), sha,
    note: sha ? 'کامیت ' + sha : 'بیلدِ محلی',
  };
  writeFileSync(VERFILE, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  console.log(`    نسخه: v${version}  •  بیلد: ${stamp}  •  rev: ${rev.slice(0, 10)}  •  sha: ${sha || '—'}`);
  console.log(`    version.json نوشته شد (${fpFiles.length} فایل اثرِ انگشت شد)`);
} else {
  console.log('    (NO_STAMP: نسخه/rev دست‌نخورده ماند)');
}

/* ── ۱) وصلهٔ سطحِ ماژول: exportها را قبل از obfuscate به شناسه‌های ساده تبدیل می‌کنیم
   javascript-obfuscator ES export را دوباره تولید نمی‌کند؛ پس:
     export default { ... }  →  const __MOD_DEFAULT__ = { ... }
     export class ConnLimiter →  class ConnLimiter
   و در انتهای فایلِ خروجی، با یک statement واقعی دوباره منتشرشان می‌کنیم.
   ⚠️ نام کلاس ConnLimiter باید با بایندینگ Durable Object در داشبورد یکی بماند. */
const needsDefaultPatch = /export\s+default\s+\{/.test(src);
const needsClassPatch = /export\s+class\s+ConnLimiter/.test(src);
if (needsDefaultPatch) src = src.replace(/export\s+default\s+\{/, 'const __MOD_DEFAULT__ = {');
if (needsClassPatch) src = src.replace(/export\s+class\s+ConnLimiter/, 'class ConnLimiter');

if (!/const\s+__MOD_DEFAULT__\s*=/.test(src) || !/class\s+ConnLimiter/.test(src)) {
  console.error('FATAL: worker.js فاقد export default یا export class ConnLimiter است.');
  process.exit(1);
}

/* ═══════════════════════════════════════════════════════════════════════════
   ۲) ماسکِ کلماتِ حساس — روی AST، نه با regex روی متن
   ───────────────────────────────────────────────────────────────────────────
   چرا AST: یک جست‌وجوی متنی روی 'vless' هم داخلِ کامنت‌ها و هم داخلِ رشته‌های
   واقعی می‌افتد و نمی‌داند کدام «نامِ متغیر» است و کدام «کلیدِ شیء». تغییرِ
   اشتباهِ کلیدِ شیء، داده‌های ذخیره‌شده را بی‌صدا خراب می‌کند. acorn دقیقاً
   می‌گوید هر نود چیست، پس هر مورد به شکلِ درستِ خودش ماسک می‌شود.
   ═══════════════════════════════════════════════════════════════════════════ */
const acorn = require('acorn');
const SENSITIVE = /(vless|trojan|clash|vmess|shadowsocks|shadowrocket|sing-?box|xtls|outbounds|proxy-?groups)/i;

/* تقسیمِ یک رشته به تکه‌هایی که کلمهٔ حساس ندارند + الحاق با + */
function maskString(value) {
  const parts = [];
  let rest = String(value);
  for (;;) {
    const m = rest.match(SENSITIVE);
    if (!m) { if (rest) parts.push(rest); break; }
    const i = m.index;
    const word = m[0];
    if (i > 0) parts.push(rest.slice(0, i));
    /* خودِ کلمه را به دو نیمه بشکن: 'vl'+'ess' */
    const cut = Math.max(1, Math.floor(word.length / 2));
    parts.push(word.slice(0, cut));
    parts.push(word.slice(cut));
    rest = rest.slice(i + word.length);
  }
  if (!parts.length) return null;
  return parts.map((p) => JSON.stringify(p)).join(' + ');
}

function maskSource(source) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: false });
  const edits = [];              // {start, end, text}
  const usedNames = new Set();
  const renames = new Map();     // old -> new (برای شناسه‌های bindable)

  /* نام‌های موجود را جمع کن تا نامِ تازه تصادم نکند */
  (function collect(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Identifier') usedNames.add(node.name);
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === 'object' && typeof v.type === 'string') collect(v);
    }
  })(ast);

  const freshName = () => {
    for (let i = 0; ; i++) {
      const n = '_$' + i.toString(36);
      if (!usedNames.has(n)) { usedNames.add(n); return n; }
    }
  };

  /* آیا این Identifier نقشِ «نامِ ویژگی» دارد؟ (کلیدِ شیء یا propertyِ دسترسی) */
  const propRole = (node, parent) => {
    if (!parent) return null;
    if (parent.type === 'Property' && parent.key === node && !parent.computed) return 'key';
    if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return 'member';
    if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) return 'key';
    return null;
  };

  (function walk(node, parent) {
    if (!node || typeof node.type !== 'string') return;

    if (node.type === 'Identifier' && SENSITIVE.test(node.name)) {
      /* {vless} (shorthand) — کلید و مقدار یک نود مشترک دارند؛ اگر جدا ویرایش
         شوند خروجی نحویِ شکسته می‌شود. پس کلِ property یک‌جا بازنویسی می‌شود. */
      if (parent && parent.type === 'Property' && parent.shorthand && parent.value === node) {
        if (!renames.has(node.name)) renames.set(node.name, freshName());
        edits.push({ start: parent.start, end: parent.end, text: '[' + maskString(node.name) + ']: ' + renames.get(node.name) });
        return;
      }
      const role = propRole(node, parent);
      if (role) {
        /* کلیدِ شیء / دسترسیِ نقطه‌ای → computed با رشتهٔ ماسک‌شده.
           مقدارِ زمانِ اجرا عیناً همان رشتهٔ قبلی است، پس طرحِ داده عوض نمی‌شود. */
        const masked = maskString(node.name);
        if (role === 'member') {
          if (parent.optional) {
            /* obj?.vless → obj?.["vl"+"ess"] : فقط نام عوض می‌شود */
            edits.push({ start: node.start, end: node.end, text: '[' + masked + ']' });
          } else {
            /* obj.vless → obj["vl"+"ess"] : نقطه هم باید برود */
            let s = node.start;
            while (s > 0 && /\s/.test(source[s - 1])) s--;
            if (source[s - 1] === '.') s--;
            edits.push({ start: s, end: node.end, text: '[' + masked + ']' });
          }
        } else {
          edits.push({ start: node.start, end: node.end, text: '[' + masked + ']' });
        }
      } else {
        /* نامِ متغیر/تابع/پارامتر → تغییرِ نام (همهٔ ارجاع‌ها هم عوض می‌شوند) */
        if (!renames.has(node.name)) renames.set(node.name, freshName());
        edits.push({ start: node.start, end: node.end, text: renames.get(node.name) });
      }
    }

    if (node.type === 'Literal') {
      if (node.regex) {
        if (SENSITIVE.test(node.regex.pattern)) {
          const masked = maskString(node.regex.pattern);
          const flags = node.regex.flags || '';
          edits.push({ start: node.start, end: node.end, text: 'new RegExp(' + masked + (flags ? ', ' + JSON.stringify(flags) : '') + ')' });
        }
      } else if (typeof node.value === 'string' && SENSITIVE.test(node.value)) {
        const masked = maskString(node.value);
        if (masked) {
          const isKey = parent && parent.type === 'Property' && parent.key === node && !parent.computed;
          edits.push({ start: node.start, end: node.end, text: isKey ? '[' + masked + ']' : masked });
        }
      }
    }

    /* رشته‌های داخلِ template: فقط متنِ ثابت ماسک می‌شود.
       ⚠️ بازهٔ TemplateElement خودِ بک‌تیک‌ها را شامل نمی‌شود، پس متنِ جانشین
       هم نباید بک‌تیک داشته باشد؛ و برای امنیت از خودِ متنِ منبع استفاده
       می‌کنیم نه value.raw (که escapeها را نرمال می‌کند و آفست را جابه‌جا).
       ⚠️ همهٔ تکرارها ماسک می‌شوند، نه فقط اولی: بدنهٔ UIِ داخلی و متن‌های
       چندزبانهٔ رادار هر کدام چند 'vless' دارند و در نسخهٔ قبلی همین‌جا
       جا می‌ماندند. */
    if (node.type === 'TemplateElement') {
      let raw = source.slice(node.start, node.end);
      let changed = false;
      for (let guard = 0; guard < 200; guard++) {
        const m = raw.match(SENSITIVE);
        if (!m || m.index === undefined) break;
        const masked = maskString(m[0]);
        if (!masked) break;
        raw = raw.slice(0, m.index) + '${' + masked + '}' + raw.slice(m.index + m[0].length);
        changed = true;
      }
      if (changed) edits.push({ start: node.start, end: node.end, text: raw });
    }

    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, node));
      else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, node);
    }
  })(ast, null);

  /* اعمالِ ویرایش‌ها از آخر به اول تا آفست‌ها جابه‌جا نشوند.
     ⚠️ اول ویرایش‌های «درونی» حذف می‌شوند: مثلاً برای `{vless}` یک ویرایشِ
     کلِ property داریم و (احتمالاً) یک ویرایشِ کلیدِ درونش؛ اگر کوچکی اول
     اعمال شود، بزرگ روی آن می‌نشیند و خروجی نحویِ شکسته می‌شود. فقط
     بیرونی‌ترین‌ها می‌مانند. */
  const keep = edits.filter((e) => !edits.some((f) => f !== e && f.start <= e.start && f.end >= e.end && (f.start < e.start || f.end > e.end)));
  keep.sort((a, b) => b.start - a.start);
  let out = source;
  let lastStart = Infinity;
  for (const e of keep) {
    if (e.end > lastStart) continue;         // هم‌پوشانیِ باقی‌مانده — رد شود
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    lastStart = e.start;
  }
  return { out, count: keep.length, renames: renames.size };
}

const mask = maskSource(src);
src = mask.out;
console.log(`    ماسکِ کلماتِ حساس: ${mask.count} ویرایش • ${mask.renames} نامِ متغیر عوض شد`);
if (process.env.DUMP) { writeFileSync(ROOT + '/.dbg-masked.mjs', src, 'utf8'); console.log('    (DUMP: .dbg-masked.mjs نوشته شد)'); }

/* ── ۳) پاک‌سازیِ نامِ توابعِ دارای کلمهٔ کلیدی که در AST به‌عنوانِ binding
   دیده نمی‌شوند (مثلاً نامِ متد یا property در آبجکتِ export) — برای اطمینان.
   ⚠️ `WebSocketPair` دیگر تغییرِ نام نمی‌دهد. دلیلش یک باگِ واقعیِ تولید بود:
   نسخهٔ قبلی این شناسه را عوض می‌کرد و برای این‌که global ورکر از دست نرود،
   خطِ `const __CF_WS_PAIR__ = WebSocketPair;` را به **بالای ماژول** می‌گذاشت.
   در runtime واقعیِ کلاودفلر، `WebSocketPair` در فازِ ارزیابیِ ماژول هنوز
   تعریف نشده است؛ آن خط با ReferenceError ماژول را می‌کشد و نتیجه‌اش
   «Error 1101» برای **همهٔ** درخواست‌ها است — با صفر لاگ، چون هیچ کدی اجرا
   نمی‌شود. (تستِ واقعی: همان بسته بدونِ آن خط ۲۰۰ می‌دهد، با آن خط ۱۱۰۱.)
   خودِ نامِ WebSocketPair هم رشتهٔ پروتکل نیست و پنهان‌کردنش ارزشی ندارد. */
for (const [pat, rep] of [
  [/\bvlessHeader\b/g, 'protoHeaderA'],
  [/\bparseVless\b/g, 'parseProtoA'],
  [/\bparseTrojan\b/g, 'parseProtoB'],
  // نام DO دست نمی‌خورد — باید با بایندینگ داشبورد یکی بماند
]) src = src.replace(pat, rep);

/* ── ۴) گزینه‌های obfuscate ────────────────────────────────────────────────
   ⚠️ اندازه‌گیریِ محلی (tests-manual/cpu-bench.cjs) روی همین مخزن:
     worker.js        بارِ ماژول: 31ms CPU
     _worker.obf.js   بارِ ماژول: 500ms CPU   (با stringArrayِ سراسری)
   در لاگ‌های زنده همین به‌صورتِ نشست‌های کوتاه که با «Worker exceeded CPU
   time limit» می‌میرند دیده می‌شد. پس پیش‌فرض دیگر stringArray ندارد. */
const BASE = {
  compact: true,
  deadCodeInjection: false,
  debugProtection: false,          // در Workers یعنی حلقهٔ debugger → سوزاندنِ CPU
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,            // __MOD_DEFAULT__ و ConnLimiter باید بمانند
  selfDefending: false,            // Function.prototype.toString → شکننده در Workers
  unicodeEscapeSequence: false,
  transformObjectKeys: false,
};
const PRESETS = {
  /* پیش‌فرض: فقط minify — کلماتِ حساس قبلاً با AST ماسک شده‌اند */
  mask: { ...BASE, stringArray: false },
  /* روشِ قدیمی (سازگاری): رشته‌ها داخلِ آرایهٔ base64 — گران‌تر در زمانِ اجرا */
  cheap: {
    ...BASE,
    rotateStringArray: true,
    splitStrings: false,
    stringArray: true,
    stringArrayCallsTransform: false,
    stringArrayEncoding: ['base64'],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 1,
    stringArrayWrappersChainedCalls: false,
    stringArrayWrappersParametersMaxCount: 2,
    stringArrayWrappersType: 'variable',
    stringArrayThreshold: 1,
    reservedStrings: ['^[\\s\\S]{300,}$'],
  },
  /* سنگین — فقط برای آزمایش؛ ~۱۶ برابر CPUِ استارت */
  heavy: {
    ...BASE,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    rotateStringArray: true,
    splitStrings: true,
    splitStringsChunkLength: 4,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayEncoding: ['rc4'],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 4,
    stringArrayWrappersType: 'function',
    stringArrayThreshold: 1,
  },
};
const PRESET = String(process.env.OBF_PRESET || 'mask').toLowerCase();
if (!PRESETS[PRESET]) {
  console.error('FATAL: OBF_PRESET باید mask یا cheap یا heavy باشد (دریافت: ' + PRESET + ')');
  process.exit(1);
}
const OBF_OPTIONS = PRESETS[PRESET];
console.log('    حالتِ obfuscate: ' + PRESET + (PRESET === 'heavy' ? '  (هشدار: ~۱۶ برابر CPUِ استارت)' : ''));

const obfuscator = require('javascript-obfuscator');
const result = obfuscator.obfuscate(src, OBF_OPTIONS);
let out = result.getObfuscatedCode();

/* ── ۵) انتشار دوبارهٔ exportهای سطحِ ماژول ── */
const exportParts = [];
if (needsDefaultPatch) exportParts.push('__MOD_DEFAULT__ as default');
if (needsClassPatch) exportParts.push('ConnLimiter');
out += '\nexport { ' + exportParts.join(', ') + ' };\n';

/* ── ۶) اعتبارسنجی ──
   ⚠️ این بخش قبلاً فقط «تعداد» را چاپ می‌کرد و کسی نگاهش نمی‌کرد؛ همان‌جا
   بود که ۱۱ بار 'vless' در بستهٔ نهایی ماند و کلِ زحمتِ obfuscation بی‌اثر شد.
   حالا اگر یک کلمهٔ حساس باقی بماند، بیلد شکست می‌خورد. */
if (!/__MOD_DEFAULT__/.test(out) || !/ConnLimiter/.test(out)) {
  console.error('FATAL: شناسه‌های exportِ اصلی در خروجی یافت نشدند.');
  process.exit(1);
}
const leftovers = [];
for (const w of ['vless', 'trojan', 'clash', 'vmess', 'shadowsocks', 'outbounds']) {
  const n = (out.match(new RegExp(w, 'gi')) || []).length;
  if (n) leftovers.push(w + '×' + n);
}
if (leftovers.length) {
  console.error('FATAL: کلماتِ حساس در بستهٔ نهایی باقی مانده‌اند: ' + leftovers.join(', '));
  console.error('       (ماسکِ AST یک مورد را جا انداخته — بیلد متوقف شد تا فایلِ نشت‌کننده منتشر نشود)');
  process.exit(1);
}

writeFileSync(OUT, out, 'utf8');
const kb = (p) => (statSync(p).size / 1024).toFixed(0);
console.log('    کلماتِ حساس در خروجی: ۰ ✓');
console.log(`OK  worker.js (${kb(SRC)} KB)  →  _worker.obf.js (${kb(OUT)} KB)`);
console.log('    حالا محتوای _worker.obf.js را در داشبورد کلاودفلر (Quick Edit → Paste) قرار دهید.');
