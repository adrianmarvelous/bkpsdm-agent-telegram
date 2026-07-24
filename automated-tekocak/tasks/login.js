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
  await page.click('button:has-text("Pilih")');
  await page.waitForURL('**/login/security', { timeout: 15000 });

  console.log('  [2] Login...');
  // Isi form login
  await page.fill('#USERNAME_LOGIN', USERNAME);
  await page.fill('#PASSWORD_LOGIN', PASSWORD);
  // Submit via JavaScript — langsung panggil API login
  const result = await page.evaluate(async ({ username, password, baseUrl }) => {
    const res = await fetch(baseUrl + 'login/login_data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ USERNAME_LOGIN: username, PASSWORD_LOGIN: password }),
    });
    const data = await res.json();
    if (data.status && data.redirect_link) {
      window.location.href = data.redirect_link;
      return { ok: true, redirect: data.redirect_link };
    }
    return { ok: false, error: data.pesan || 'Login gagal' };
  }, { username: USERNAME, password: PASSWORD, baseUrl: config.TEKOCAK_URL.replace(/\/+$/, '') + '/' });
  if (!result.ok) throw new Error(result.error);
  await page.waitForURL('**/dashboard', { timeout: 60000 });
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
