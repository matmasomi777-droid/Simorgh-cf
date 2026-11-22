#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  cf-diagnose.mjs — تشخیصِ ۱۱۰۱ با APIِ کلاودفلر (فقط-خواندنی)
 *  ───────────────────────────────────────────────────────────────────────────
 *  چرا: تا حالا حدس می‌زدیم. با یک توکنِ کلاودفلر می‌شود *واقعیت* را دید:
 *    • آیا توکن معتبر است و به کدام حساب‌ها دسترسی دارد
 *    • ورکرها و آخرین زمانِ استقرارشان (یعنی آیا نسخهٔ تازه واقعاً مستقر شده)
 *    • بایندینگ‌ها، compatibility_date و flags  ← منبعِ رایجِ ۱۱۰۱
 *    • شمارشِ درخواست/خطا در ۲۴ ساعتِ گذشته (اگر خطا ۱۰۰٪ باشد، سرویس بالا نمی‌آید)
 *
 *  این اسکریپت **هیچ چیزی را تغییر نمی‌دهد** — همه‌ی درخواست‌ها GET/read-only اند.
 *
 *  استفاده:
 *    CF_API_TOKEN=... node scripts/cf-diagnose.mjs
 *    CF_API_TOKEN=... CF_SCRIPT=panel node scripts/cf-diagnose.mjs
 *  یا توکن را در فایل بگذارید:  CF_TOKEN_FILE=.cf_token node scripts/cf-diagnose.mjs
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
const token = (process.env.CF_API_TOKEN
  || (process.env.CF_TOKEN_FILE ? readFileSync(process.env.CF_TOKEN_FILE, 'utf8').trim() : '')
  || '').trim();

if (!token) {
  console.error('توکن پیدا نشد. CF_API_TOKEN یا CF_TOKEN_FILE را بدهید.');
  process.exit(2);
}

const H = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };

async function api(path, opts = {}) {
  const res = await fetch(API + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { status: res.status, ok: !!(body && body.success), body };
}

const line = (s = '') => console.log(s);
const head = (s) => { line(); line('── ' + s + ' ' + '─'.repeat(Math.max(0, 58 - s.length))); };

(async () => {
  /* ── ۱) اعتبارِ توکن ── */
  head('توکن');
  const v = await api('/user/tokens/verify');
  if (!v.ok) {
    const err = (v.body && v.body.errors && v.body.errors[0]) || {};
    line(`  ✗ توکن معتبر نیست — ${err.code || v.status}: ${err.message || 'unknown'}`);
    line('    توکنِ منقضی/حذف‌شده/ناقص را نمی‌شود استفاده کرد. یکی تازه بسازید:');
    line('    dash.cloudflare.com → My Profile → API Tokens → Create Token');
    line('    دسترسی‌های لازم (Read کافی است): Account → Workers Scripts:Read, Account Settings:Read');
    process.exit(1);
  }
  line('  ✓ توکن معتبر است' + (v.body.result && v.body.result.status ? ` (${v.body.result.status})` : ''));

  /* ── ۲) حساب‌ها ── */
  head('حساب‌ها');
  const acc = await api('/accounts?per_page=50');
  const accounts = (acc.body && acc.body.result) || [];
  if (!accounts.length) { line('  ✗ هیچ حسابی در دسترس نیست (توکن دسترسیِ Account ندارد).'); process.exit(1); }
  accounts.forEach((a) => line(`  • ${a.name}  (${a.id})`));

  for (const a of accounts) {
    /* ── ۳) ورکرها ── */
    head(`ورکرها — ${a.name}`);
    const sc = await api(`/accounts/${a.id}/workers/scripts`);
    if (!sc.ok) { line('  ✗ خواندنِ فهرستِ ورکرها نشد (Workers Scripts:Read لازم است).'); continue; }
    const scripts = (sc.body.result) || [];
    if (!scripts.length) { line('  (خالی)'); continue; }
    const now = Date.now();
    scripts.forEach((s) => {
      const age = s.modified_on ? Math.round((now - Date.parse(s.modified_on)) / 60000) : null;
      line(`  • ${s.id.padEnd(24)} آخرین تغییر: ${s.modified_on || '?'}${age !== null ? `  (${age} دقیقه پیش)` : ''}`);
    });

    /* ── ۴) جزئیاتِ اسکریپتِ هدف ── */
    const want = process.env.CF_SCRIPT || '';
    const target = want
      ? scripts.find((s) => s.id === want)
      : scripts.find((s) => /panel|simorgh|sub/i.test(s.id)) || scripts[0];
    if (!target) continue;

    head(`جزئیات — ${target.id}`);
    /* استقرارها: نشان می‌دهد نسخهٔ تازه واقعاً live شده یا نه */
    const dep = await api(`/accounts/${a.id}/workers/scripts/${target.id}/deployments`);
    if (dep.ok) {
      const d = (dep.body.result && dep.body.result.deployments) || [];
      d.slice(0, 3).forEach((x) => line(`  استقرار: ${x.created_on} • ${(x.versions || []).map((vv) => vv.version_id).join(',')}`));
    } else line('  (استقرارها خوانده نشد: ' + dep.status + ')');

    /* تنظیمات: compatibility_date / flags / بایندینگ‌ها — منبعِ کلاسیکِ ۱۱۰۱ */
    for (const p of [`/accounts/${a.id}/workers/scripts/${target.id}/settings`, `/accounts/${a.id}/workers/scripts/${target.id}/script-settings`]) {
      const st = await api(p);
      if (st.ok && st.body.result) {
        const r = st.body.result;
        line('  تنظیمات:');
        line('    compatibility_date : ' + (r.compatibility_date || '(پیش‌فرض)'));
        line('    compatibility_flags: ' + JSON.stringify(r.compatibility_flags || []));
        line('    bindings           : ' + JSON.stringify((r.bindings || []).map((b) => b.name + ':' + b.type)));
        if ((r.compatibility_flags || []).includes('nodejs_compat') && r.compatibility_date && r.compatibility_date >= '2026-08-04') {
          line('    ⚠️ فلگِ nodejs_compat با تاریخِ ≥ 2026-08-04 تکراری است و می‌تواند');
          line('       خطای راه‌اندازی (و ۱۱۰۱) بدهد — حذفش کنید.');
        }
        break;
      }
    }

    /* ── ۵) آمارِ درخواست/خطا در ۲۴ ساعت ── */
    head('آمار ۲۴ ساعت (GraphQL)');
    const q = `query($tag:String!,$from:Time!,$to:Time!){
      viewer{ accounts(filter:{accountTag:$tag}){
        workersInvocationsAdaptive(limit:50, filter:{datetime_geq:$from, datetime_leq:$to}){
          sum{ requests errors } dimensions{ status scriptName }
        } } } }`;
    const gql = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST', headers: H,
      body: JSON.stringify({ query: q, variables: { tag: a.id, from: new Date(Date.now() - 86400000).toISOString(), to: new Date().toISOString() } }),
    }).then((r) => r.json()).catch(() => null);
    const rows = gql && gql.data && gql.data.viewer && gql.data.viewer.accounts && gql.data.viewer.accounts[0]
      && gql.data.viewer.accounts[0].workersInvocationsAdaptive;
    if (rows && rows.length) {
      const byStatus = new Map();
      let req = 0, err = 0;
      rows.forEach((r) => {
        req += r.sum.requests; err += r.sum.errors;
        const k = String(r.dimensions.status);
        byStatus.set(k, (byStatus.get(k) || 0) + r.sum.requests);
      });
      line(`  درخواست: ${req}  •  خطا: ${err}  (${req ? ((err / req) * 100).toFixed(1) : 0}%)`);
      [...byStatus.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).forEach(([k, n]) => line(`    status ${k.padEnd(6)} → ${n}`));
      if (req && err / req > 0.9) line('  ⚠️ تقریباً همهٔ درخواست‌ها خطا هستند — سرویس بالا نمی‌آید، نه این‌که کد اشکال داشته باشد.');
    } else {
      line('  (داده‌ای برنگشت — یا دسترسیِ Analytics نیست یا ترافیکی نبوده)');
    }
  }

  head('جمع‌بندی');
  line('  اگر «تنظیمات» فلگِ اضافی نشان داد → همان را بردارید و دوباره تست کنید.');
  line('  اگر همهٔ درخواست‌ها خطا بودند ولی اسکریپت تازه است → probe-worker.js را');
  line('  در ورکرِ تازه امتحان کنید؛ اگر آن هم خطا داد، مشکل از حساب است نه کد.');
})();
