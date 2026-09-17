/**
 * Automasi login Organisasi IKO Monev 2026 (headless, siap VPS).
 *
 * Alur: isi username/password → simpan gambar CAPTCHA ke captcha.png →
 * minta kode CAPTCHA (arg CLI / env / prompt) → submit → simpan PHPSESSID
 * ke session.json agar monitor.js jalan tanpa login ulang.
 *
 * Cara pakai:
 *   node index.js                      → headless, minta CAPTCHA via prompt
 *   node index.js 4KmZu               → headless, kode CAPTCHA dari arg
 *   ORGANISASI_CAPTCHA=4KmZu node index.js
 *   HEADLESS=false node index.js       → mode terlihat (inspeksi lokal)
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') }); // root .env (env digabung)

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { chromium } = require('playwright');

const LOGIN_URL = 'https://organisasi.surabaya.go.id/monev2026/login-route';
const CAPTCHA_FILE = path.join(__dirname, 'captcha.png');
const SESSION_FILE = path.join(__dirname, 'session.json');
const username = process.env.ORGANISASI_USERNAME;
const password = process.env.ORGANISASI_PASSWORD;
// Default headless (dijalankan di VPS). Untuk mode terlihat: HEADLESS=false
const headless = process.env.HEADLESS !== 'false';
// Kode CAPTCHA bisa via arg CLI, env ORGANISASI_CAPTCHA, atau prompt interaktif
const CAPTCHA_ARG = process.argv[2] || process.env.ORGANISASI_CAPTCHA || null;

function ask(question) {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => input.question(question, (answer) => {
    input.close();
    resolve(answer.trim());
  }));
}

async function main() {
  if (!username || !password) {
    throw new Error('ORGANISASI_USERNAME dan ORGANISASI_PASSWORD wajib diisi di .env');
  }

  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    console.log(`Membuka ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 30000 });
    await page.locator('form.form-box').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(password);

    await page.locator('.captcha-img').screenshot({ path: CAPTCHA_FILE });
    console.log(`CAPTCHA tersimpan di: ${CAPTCHA_FILE}`);
    if (headless) console.log('Mode headless — baca kode dari captcha.png lalu masukkan di bawah.');

    let captcha = CAPTCHA_ARG;
    if (!captcha) captcha = await ask('Masukkan kode CAPTCHA: ');
    if (!captcha) throw new Error('Kode CAPTCHA tidak boleh kosong');

    await page.locator('input[name="captcha"]').fill(captcha);
    await page.locator('form.form-box').locator('button[type="submit"]').click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

    const currentUrl = page.url();
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const loginPage = currentUrl.includes('/login-route');
    const failed = /captcha|kata sandi|password|gagal|salah|invalid/i.test(bodyText) && loginPage;

    if (failed) {
      console.log('Login gagal atau CAPTCHA tidak diterima. URL masih di halaman login.');
      return;
    }

    console.log(`Login berhasil atau halaman berpindah. URL: ${currentUrl}`);

    // Simpan PHPSESSID agar monitor.js berjalan tanpa perlu login ulang
    try {
      const cookies = await page.context().cookies('https://organisasi.surabaya.go.id');
      const sess = cookies.find((c) => c.name === 'PHPSESSID');
      if (sess) {
        fs.writeFileSync(
          SESSION_FILE,
          JSON.stringify({ phpsessid: sess.value, savedAt: new Date().toISOString() }, null, 2)
        );
        console.log('✅ Sesi (PHPSESSID) disimpan ke session.json');
      } else {
        console.warn('⚠️ PHPSESSID tidak ditemukan di cookie — session.json tidak diperbarui.');
      }
    } catch (e) {
      console.warn('⚠️ Gagal menyimpan sesi:', e.message);
    }
  } finally {
    if (headless) await browser.close();
    else console.log('Browser dibiarkan terbuka untuk pemeriksaan hasil login.');
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});