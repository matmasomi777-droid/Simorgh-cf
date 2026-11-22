/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  probe-worker.js — «آزمونِ خالی» برای جدا کردنِ تقصیرها
 *  ───────────────────────────────────────────────────────────────────────────
 *  اگر پنلِ اصلی خطای 1101 می‌دهد و نمی‌دانید از کد است یا از حساب/شبکه،
 *  همین فایلِ ۳۰ خطی را در یک ورکرِ تازه پیست کنید و آدرسش را باز کنید:
 *
 *    • اگر همین هم 1101 داد  → مشکل از حساب/پلتفرم است، نه از کدِ پنل.
 *        (گزارش‌های واقعیِ همین الگو: پنل‌های تازه‌ساخته بلافاصله 1101 می‌دهند،
 *         وابسته به اکانت، و هم‌زمان ایمیلِ abuse هم می‌آید.)
 *        راه‌حل: ورکر/اکانتِ تازه با نامِ بی‌ربط، دامنهٔ اختصاصی به‌جای
 *        workers.dev، و بررسیِ Settings → Runtime → Compatibility flags.
 *
 *    • اگر «PROBE OK» داد → حساب سالم است و مشکل در استقرارِ پنل است:
 *        نسخهٔ درستِ _worker.obf.js را پیست نکرده‌اید، یا بایندینگ/تنظیماتِ
 *        Runtime (مثلاً nodejs_compatِ اضافی) با compatibility_date ناسازگار است.
 *
 *  خروجی شاملِ چیزهایی است که معمولاً علتِ 1101 می‌شوند: تاریخِ سازگاری،
 *  فعال بودنِ nodejs_compat، و این‌که WebSocketPair/connect در دسترس‌اند.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { connect } from 'cloudflare:sockets';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const out = {
      ok: true,
      probe: 'PROBE OK',
      time: new Date().toISOString(),
      colo: (request.cf && request.cf.colo) || '?',
      country: (request.cf && request.cf.country) || '?',
      path: url.pathname,
      runtime: {
        /* nodejs_compat برای تاریخ‌های ≥ 2026-08-04 خودکار روشن است */
        nodejsCompat: typeof process !== 'undefined' && !!(process && process.versions),
        nodeVersion: (typeof process !== 'undefined' && process.versions && process.versions.node) || null,
        buffer: typeof Buffer !== 'undefined',
        compression: typeof CompressionStream === 'function',
        webSocketPair: typeof WebSocketPair === 'function',
        sockets: typeof connect === 'function',
        cryptoSubtle: !!(globalThis.crypto && globalThis.crypto.subtle),
      },
      bindings: Object.keys(env || {}),
    };
    return new Response(JSON.stringify(out, null, 2), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  },
};
