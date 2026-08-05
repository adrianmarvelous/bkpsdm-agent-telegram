/**
 * Task 1: Login TEKO-CAK
 *
 * Standalone: node tasks/login.js
 */

const { chromium } = require('playwright');
const { USERNAME, PASSWORD, TAHUN, HEADLESS } = require('../config');
const config = require('../config');

async function run(page) {
  console.log('═══════════════════════════════════════');
  console.log('  TASK 1: LOGIN');
  console.log('═══════════════════════════════════════');

  await page.goto('https://teko-cak.surabaya.go.id/login', { waitUntil: 'load', timeout: 60000 });
  console.log('  [1] Pilih tahun...');
  await page.selectOption('select', TAHUN);
  // Gunakan Promise.all agar waitForNavigation menangkap navigasi setelah klik
  // waitUntil: 'load' — bukan networkidle, karena ada polling/keepalive
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load' }),
    page.click('button:has-text("Pilih")')
  ]);
  console.log('  [2] Login...');
  // Isi form login
  await page.fill('#USERNAME_LOGIN', USERNAME);
  await page.fill('#PASSWORD_LOGIN', PASSWORD);
  // Gunakan klik tombol MASUK langsung, bukan JS fetch
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load' }),
    page.click('button:has-text("MASUK")')
  ]);
  // Pastikan kita di dashboard
  const finalUrl = page.url();
  if (finalUrl.includes('/dashboard')) {
    console.log('  ✓ Login berhasil! (URL: ' + finalUrl + ')');
  } else {
    console.log('  ? URL setelah login: ' + finalUrl);
  }

  // Tutup modal jika ada
  try {
    const btn = page.locator('button:has-text("Close"), button:has-text("×")').first();
    await btn.waitFor({ state: 'visible', timeout: 3000 });
    await btn.click();
  } catch { /* ok */ }
}

// ===== Standalone =====
if (require.main === module) {
  (async () => {
    const browser = await chromium.launch({ headless: config.HEADLESS, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await run(page);
      console.log('\n✅ Task Login selesai!');
      await browser.close();
    } catch (e) {
      console.error('✗ Error:', e.message);
      await browser.close();
    }
  })();
}

module.exports = { run, nama: 'Login' };
