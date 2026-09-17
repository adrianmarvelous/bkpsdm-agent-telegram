/**
 * Auto-login Monev Organisasi — baca CAPTCHA pakai AI vision, tanpa manusia.
 *
 * Alur: buka halaman login → isi username/password → screenshot CAPTCHA →
 * kirim ke OpenRouter (model vision) → isi kode → submit →
 * simpan PHPSESSID baru ke session.json agar monitor.js pulih otomatis.
 *
 * FALLBACK MANUAL: kalau AI gagal membaca CAPTCHA, gambar captcha dikirim ke
 * Telegram user (CHAT_ID) dan skrip menunggu kode yang diketik user. Bot utama
 * (src/telegram/bot.js) menulis balasan user ke captcha_answer.txt.
 * Pola sama dengan automated-pengaduan-listener.
 *
 * Dipanggil oleh auto-login-check.sh (cron) saat umur sesi >= 2,5 jam.
 * Bisa juga manual: node auto-login.js
 *
 * Config (root .env):
 *   ORGANISASI_CAPTCHA_MODEL    model vision (default: nemotron-3-nano-omni :free)
 *   AUTOLOGIN_AI_TRIES          berapa kali AI dicoba baca captcha SEBELUM captcha
 *                               dikirim ke user untuk dibaca manual (default 5)
 *   AUTOLOGIN_MANUAL_TRIES      berapa kali putaran MANUAL diulang kalau kode ditolak
 *                               (tiap putaran captcha BARU dikirim ulang ke user) — default 3
 *                               (nama lama AUTOLOGIN_MAX_ATTEMPTS masih dibaca)
 */
// Env digabung ke root .env (ORGANISASI_* + TELEGRAM + OPENROUTER) — sama seperti modul lain.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const DIR = __dirname;
const LOGIN_URL = 'https://organisasi.surabaya.go.id/monev2026/login-route';
const CAPTCHA_FILE = path.join(DIR, 'captcha_auto.png');
const SESSION_FILE = path.join(DIR, 'session.json');
// Fallback manual (pola sama dgn automated-pengaduan-listener):
// pending_captcha.json ditulis di sini; bot utama menulis jawaban user ke captcha_answer.txt.
const PENDING_FILE = path.join(DIR, 'pending_captcha.json');
const ANSWER_FILE = path.join(DIR, 'captcha_answer.txt');
// Berapa lama menunggu jawaban user (ms). Bisa ditimpa env untuk pengujian
// (AUTOLOGIN_CAPTCHA_TIMEOUT_MS) supaya alur manual bisa diuji tanpa menunggu 10 menit penuh.
const CAPTCHA_TIMEOUT_MS = parseInt(process.env.AUTOLOGIN_CAPTCHA_TIMEOUT_MS || String(10 * 60 * 1000), 10) || 10 * 60 * 1000;

const username = process.env.ORGANISASI_USERNAME;
const password = process.env.ORGANISASI_PASSWORD;
const OR_KEY = process.env.OPENROUTER_API_KEY;
const CAPTCHA_MODEL = process.env.ORGANISASI_CAPTCHA_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
// Putaran MANUAL: kalau kode dari user ditolak, captcha sudah berganti — jadi tiap
// putaran mengambil captcha BARU dan mengirim gambarnya lagi ke user (permintaan user).
const MANUAL_MAX_TRIES = parseInt(
  process.env.AUTOLOGIN_MANUAL_TRIES || process.env.AUTOLOGIN_MAX_ATTEMPTS || '3', 10,
) || 3;
// Permintaan user (10 Sep 2026): "coba AI baca captcha dulu sampai gagal 5x,
// baru kirim ke aku biar aku yang baca". Sebelumnya AI hanya dicoba 1× sebelum
// bertanya ke user (loop MAX_ATTEMPTS lama hanya mengulang setelah kode DITOLAK).
const AI_MAX_TRIES = parseInt(process.env.AUTOLOGIN_AI_TRIES || '5', 10) || 5;
// Perbaikan 13 Sep 2026 (permintaan user): kegagalan JARINGAN ≠ AI salah baca captcha.
// Dulu keduanya diperlakukan sama, sehingga saat situs menolak koneksi (ERR_CONNECTION_REFUSED)
// skrip langsung meminta captcha manual ke user — padahal AI belum pernah melihat captcha-nya.
// Sekarang: error jaringan di-retry (tanpa mengganggu user), dan user HANYA dihubungi kalau
// halaman terbuka normal tapi AI salah baca AI_MAX_TRIES×.
const NET_MAX_TRIES = parseInt(process.env.AUTOLOGIN_NET_TRIES || '3', 10) || 3;
const NET_BACKOFF_SEC = (process.env.AUTOLOGIN_NET_BACKOFF || '20,60,120')
  .split(',').map((n) => parseInt(n, 10) || 30);

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = (process.env.ALLOWED_CHAT_IDS || '').split(',')[0] || null;

function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }

async function tgSend(text) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) { log('⚠️  TG tidak dikonfigurasi — alert dilewati.'); return; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) log('⚠️  tgSend gagal:', res.status);
  } catch (e) { log('⚠️  tgSend error:', e.message); }
}

/** Kirim FOTO (gambar captcha) ke Telegram. Return true kalau terkirim. */
async function tgSendPhoto(pngPath, caption) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) { log('⚠️  TG tidak dikonfigurasi — foto captcha tidak terkirim.'); return false; }
  try {
    const fd = new FormData();
    fd.append('chat_id', CHAT_ID);
    fd.append('caption', caption);
    fd.append('parse_mode', 'HTML');
    fd.append('photo', new Blob([fs.readFileSync(pngPath)], { type: 'image/png' }), 'captcha.png');
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, { method: 'POST', body: fd });
    if (!res.ok) { log('⚠️  tgSendPhoto gagal:', res.status, (await res.text()).slice(0, 150)); return false; }
    return true;
  } catch (e) { log('⚠️  tgSendPhoto error:', e.message); return false; }
}

/**
 * FALLBACK MANUAL — kirim gambar captcha ke user, lalu tunggu kode ketikan user.
 * Bot utama menulis balasan user ke ANSWER_FILE. Return kode, atau null (timeout).
 */
async function askUserForCaptcha(infoTambahan = '') {
  if (!TELEGRAM_TOKEN || !CHAT_ID) { log('⚠️  TG tidak dikonfigurasi — captcha manual tidak bisa diminta.'); return null; }

  const deadline = Date.now() + CAPTCHA_TIMEOUT_MS;
  // Batas waktu ditampilkan dalam WIB (UTC+7) — TZ server +08, jadi jangan pakai toLocaleString.
  const batasWib = new Date(deadline + 7 * 3600 * 1000).toISOString().slice(11, 19);

  fs.writeFileSync(PENDING_FILE, JSON.stringify({ chatId: CHAT_ID, createdAt: Date.now() }));
  if (fs.existsSync(ANSWER_FILE)) fs.unlinkSync(ANSWER_FILE);

  const sent = await tgSendPhoto(
    CAPTCHA_FILE,
    '🔐 <b>Auto-login Organisasi IKO — butuh bantuan</b>'
    + (infoTambahan ? `\n<i>${infoTambahan}</i>` : '')
    + '\n\nBalas pesan ini dengan <b>kode captcha</b> pada gambar.'
    + `\n⏰ <b>Jawab sebelum ${batasWib} WIB</b> (batas 10 menit).`
    + '\n♻️ Kalau kode ditolak, captcha <b>baru</b> akan dikirim otomatis ke sini — baca yang terbaru.',
  );
  if (!sent) return null;
  log(`🙋 Menunggu jawaban captcha manual dari user… (batas ${batasWib} WIB)`);

  while (Date.now() < deadline) {
    if (fs.existsSync(ANSWER_FILE)) {
      const code = fs.readFileSync(ANSWER_FILE, 'utf-8').trim();
      try { fs.unlinkSync(ANSWER_FILE); } catch (_) {}
      try { if (fs.existsSync(PENDING_FILE)) fs.unlinkSync(PENDING_FILE); } catch (_) {}
      log(code ? `🔑 Kode manual diterima: ${code}` : '⚠️  Jawaban manual kosong');
      return code || null;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  try { if (fs.existsSync(PENDING_FILE)) fs.unlinkSync(PENDING_FILE); } catch (_) {}
  log('⏰ Timeout menunggu captcha manual');
  return null;
}

/** Baca CAPTCHA via OpenRouter vision. Kembalikan kode bersih atau null. */
async function readCaptchaAI(pngPath) {
  if (!OR_KEY) throw new Error('OPENROUTER_API_KEY tidak tersedia');
  const b64 = fs.readFileSync(pngPath).toString('base64');
  const body = {
    model: CAPTCHA_MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Transkripsi PERSIS karakter pada gambar captcha ini. Aturan: hanya keluarkan kode captcha-nya saja, tanpa teks lain, tanpa spasi, tanpa tanda kutip. Perhatikan huruf besar vs kecil, angka, dan simbol khusus (@ # $ % & ( ) ! ? + = * < >). Kode captcha biasanya 6 karakter.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    }],
    // max_tokens 30 terlalu kecil utk model reasoning: token penalaran menghabiskan
    // kuota sebelum model sempat menulis jawaban -> content kosong -> captcha "tidak valid".
    // 200 = cukup utk penalaran singkat + jawaban. (Terbukti: 30 -> kosong 3/3; 200 -> valid 3/3.)
    max_tokens: 200,
  };
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OR_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const d = await res.json();
  let code = (d.choices?.[0]?.message?.content || '').trim();
  // Karakter captcha situs TERBUKTI termasuk bracket: kode "uq5x[p" berhasil login.
  // Sebelumnya bracket dibuang di sini -> kode jadi salah walau AI membacanya benar.
  code = code.replace(/[^A-Za-z0-9@#$%&()!?+=*<>[\]{}-]/g, '');
  return code.length >= 4 && code.length <= 8 ? code : null;
}

/**
 * Satu percobaan login. Mengembalikan OBJEK BERSTATUS supaya pemanggil bisa membedakan
 * kegagalan jaringan dari kegagalan baca captcha (perbaikan 13 Sep 2026).
 *
 *   mode 'ai'     → baca captcha pakai AI (AI_MAX_TRIES×). TIDAK PERNAH bertanya ke user.
 *   mode 'manual' → muat halaman, screenshot captcha yang berlaku, kirim ke user, tunggu jawaban.
 *
 * status: 'ok'       → login berhasil, session.json diperbarui
 *         'network'  → halaman login TIDAK BISA DIMUAT dari VPS (captcha belum pernah terbaca)
 *         'nocode'   → halaman terbuka, tapi tidak ada kode captcha yang bisa dipakai
 *         'rejected' → kode ada tapi ditolak server (captcha salah/berganti)
 *         'error'    → error lain (mis. PHPSESSID tidak ada)
 */
async function attemptLogin(mode = 'ai', infoManual = '') {
  const useAi = mode === 'ai';
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    /**
     * Muat halaman login + isi kredensial. Dipanggil ULANG untuk memperoleh captcha
     * yang benar-benar BARU — setiap muat halaman menghasilkan captcha berbeda, jadi
     * tiap percobaan AI melihat gambar yang berbeda (bukan 5× gambar yang sama).
     */
    const muatLogin = async () => {
      await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 30000 });
      await page.locator('form.form-box').waitFor({ state: 'visible', timeout: 30000 });
      await page.locator('input[name="username"]').fill(username);
      await page.locator('input[name="password"]').fill(password);
      await page.waitForTimeout(600);
    };

    // Halaman login tidak bisa dimuat → kegagalan JARINGAN/server, bukan salah baca captcha.
    try {
      await muatLogin();
    } catch (e) {
      const msg = String(e.message || e).split('\n')[0];
      log(`🌐 Halaman login tidak bisa dimuat: ${msg}`);
      return { status: 'network', error: msg };
    }

    // 1) Mode 'ai': SATU pembacaan captcha per pemanggilan. Pengulangan sampai
    //    AI_MAX_TRIES× dilakukan oleh loop di main() — tiap ulangan memuat halaman dari nol
    //    sehingga captcha yang dibaca memang BARU, dan jumlah percobaan tepat AI_MAX_TRIES
    //    (bukan AI_MAX_TRIES × AI_MAX_TRIES: pernah salah 25× saat perbaikan 13 Sep 2026).
    //    Mode 'ai' TIDAK pernah memanggil user — keputusan memanggil user ada di main().
    let code = null;
    let via = 'AI';
    if (useAi) {
      await page.locator('.captcha-img').screenshot({ path: CAPTCHA_FILE });
      try {
        code = await readCaptchaAI(CAPTCHA_FILE);
      } catch (e) {
        log(`⚠️  AI error saat membaca captcha: ${String(e.message || e).split('\n')[0]}`);
        code = null;
      }
      if (code) log(`🤖 AI membaca captcha: ${code}`);
      else log('⚠️  AI tidak menghasilkan kode valid.');
    }

    // 2) Mode manual (atau AI habis di dalam fungsi ini) → screenshot ULANG lalu tanya user.
    //    Jalur manual murni TIDAK melewati loop AI di atas, sehingga screenshot ulang WAJIB:
    //    tanpa itu CAPTCHA_FILE masih berisi gambar lama → user dikirimi captcha BASI.
    //    (Ketahuan saat uji 10 Sep 2026.) Kalau halaman sudah tidak bisa dimuat, muatLogin()
    //    di atas/loop sudah mengembalikan 'network' sehingga TIDAK ADA foto yang dikirim.
    if (!code) {
      await page.locator('.captcha-img').screenshot({ path: CAPTCHA_FILE });
      via = 'manual';
      code = await askUserForCaptcha(infoManual);
    }
    if (!code) { log('⚠️  Tidak ada kode captcha (AI gagal & jawaban manual tidak ada).'); return { status: 'nocode' }; }
    log(`🔑 Kode captcha via ${via}: ${code}`);

    await page.locator('input[name="captcha"]').fill(code);
    await page.locator('form.form-box').locator('button[type="submit"]').click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

    const currentUrl = page.url();
    if (currentUrl.includes('/login-route')) {
      log(`✖️  Kode ditolak (${code}) — masih di halaman login.`);
      return { status: 'rejected' };
    }
    const cookies = await ctx.cookies('https://organisasi.surabaya.go.id');
    const sess = cookies.find((c) => c.name === 'PHPSESSID');
    if (!sess) { log('⚠️  PHPSESSID tidak ditemukan setelah login.'); return { status: 'error', error: 'PHPSESSID tidak ada' }; }
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ phpsessid: sess.value, savedAt: new Date().toISOString() }, null, 2));
    log(`✅ Login berhasil. URL: ${currentUrl}`);
    log(`✅ session.json diperbarui (${sess.value.slice(0, 6)}…, savedAt now).`);
    return { status: 'ok', session: sess.value };
  } finally {
    await browser.close();
  }
}

(async () => {
  if (!username || !password) { console.error('ORGANISASI_USERNAME/PASSWORD belum diisi.'); process.exit(1); }
  log('🚀 Auto-login dimulai.');

  // ── FASE 1: AI, maksimal AI_MAX_TRIES× SALAH BACA. Kegagalan JARINGAN dihitung terpisah:
  //    hanya di-retry dengan jeda dan TIDAK memicu permintaan captcha ke user
  //    (perbaikan 13 Sep 2026 — dulu ERR_CONNECTION_REFUSED langsung "menyerahkan" ke user). ──
  let aiFail = 0;
  let netFail = 0;
  while (aiFail < AI_MAX_TRIES) {
    let res;
    try {
      res = await attemptLogin('ai');
    } catch (e) {
      log(`❌ Percobaan AI error: ${String(e.message || e).split('\n')[0]}`);
      res = { status: 'error' };
    }
    if (res.status === 'ok') process.exit(0);

    if (res.status === 'network') {
      netFail++;
      if (netFail > NET_MAX_TRIES) {
        log(`💥 Halaman login tidak bisa diakses ${netFail}× — masalah situs/jaringan, bukan captcha.`);
        await tgSend(`🌐 <b>Monev Organisasi — situs tidak bisa diakses.</b>\nHalaman login gagal dimuat ${netFail}× dari VPS (<i>${res.error}</i>).\nCaptcha manual TIDAK diminta karena halaman loginnya sendiri yang tidak bisa dibuka. Monitor mencoba lagi otomatis 30 menit lagi.`);
        process.exit(1);
      }
      const jeda = NET_BACKOFF_SEC[Math.min(netFail - 1, NET_BACKOFF_SEC.length - 1)];
      log(`🌐 Gangguan jaringan ke-${netFail}/${NET_MAX_TRIES} — tunggu ${jeda}s lalu coba AI lagi (user tidak diganggu).`);
      await new Promise((r) => setTimeout(r, jeda * 1000));
      continue; // tidak menambah aiFail: ini bukan salah baca captcha
    }

    aiFail++;
    log(`⚠️  AI gagal baca/ditolak ${aiFail}/${AI_MAX_TRIES} (${res.status}).`);
    if (aiFail < AI_MAX_TRIES) await new Promise((r) => setTimeout(r, 3000));
  }

  // ── FASE 2: MANUAL — HANYA kalau halaman terbuka normal tapi AI salah baca AI_MAX_TRIES×.
  //    Tiap putaran mengambil captcha BARU dan mengirim gambarnya lagi ke user — jadi kalau
  //    kode pertama ditolak (captcha sudah berganti), user tetap menerima gambar yang berlaku. ──
  log(`🙋 AI salah baca ${AI_MAX_TRIES}× — kirim captcha ke user.`);
  for (let m = 1; m <= MANUAL_MAX_TRIES; m++) {
    log(`🙋 Beralih ke input manual — putaran ${m}/${MANUAL_MAX_TRIES}.`);
    try {
      const res = await attemptLogin('manual', `Putaran manual ${m}/${MANUAL_MAX_TRIES}`);
      if (res.status === 'ok') process.exit(0);
      if (res.status === 'network') {
        log(`🌐 Situs putus di tengah jalur manual (${res.error}) — berhenti, minta captcha tidak ada gunanya.`);
        await tgSend(`🌐 <b>Monev Organisasi — situs putus di tengah login manual.</b>\nHalaman login tak bisa dimuat (<i>${res.error}</i>) sehingga permintaan captcha dibatalkan. Coba lagi otomatis 30 menit lagi.`);
        process.exit(1);
      }
    } catch (e) {
      log(`❌ Percobaan manual ${m} error: ${String(e.message || e).split('\n')[0]}`);
    }
    if (m < MANUAL_MAX_TRIES) {
      log('↻ Kode ditolak — captcha BARU akan dikirim ke user untuk putaran berikutnya.');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  log('💥 Gagal (AI + manual) — kirim alert ke Telegram.');
  await tgSend(`⚠️ <b>Monev Organisasi — auto-login gagal.</b>\nAI sudah salah baca ${AI_MAX_TRIES}× dan ${MANUAL_MAX_TRIES} putaran jawaban manual tidak berhasil. Silakan login manual: <code>node index.js</code> di automated-organisasi-iko.`);
  process.exit(1);
})();
