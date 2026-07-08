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

  await page.goto('https://teko-cak.surabaya.go.id/login', { waitUntil: 'networkidle' });
  console.log('  [1] Pilih tahun...');
  await page.selectOption('select', TAHUN);
  await page.click('button:has-text("Pilih")');
  await page.waitForURL('**/login/security', { timeout: 15000 });

  console.log('  [2] Login...');
  await page.locator('input[type="text"]').first().fill(USERNAME);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.click('button:has-text("MASUK")');
  await page.waitForURL('**/dashboard', { timeout: 20000 });
  console.log('  ✓ Login berhasil!');

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
    const browser = await chromium.launch({ headless: config.HEADLESS });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await run(page);
      console.log('\n✅ Task Login selesai!');
      await page.pause();
    } catch (e) {
      console.error('✗ Error:', e.message);
      await browser.close();
    }
  })();
}

module.exports = { run, nama: 'Login' };
