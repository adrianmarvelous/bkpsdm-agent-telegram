/**
 * Task 3: Update Data Pegawai
 *
 * Standalone (login otomatis): node tasks/update-pegawai.js
 * Terintegrasi (sudah login):  panggil updatePegawai.run(page, browser)
 */

const { chromium } = require('playwright');
const { loginThenRun } = require('./_helper');
const { HALAMAN_PEGAWAI, INSTANSI, DAFTAR_NIP, HEADLESS } = require('../config');

async function run(page, browser, nipList = null) {
  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('  TASK 3: UPDATE DATA PEGAWAI');
  console.log('═══════════════════════════════════════');

  await page.goto(HALAMAN_PEGAWAI, { waitUntil: 'load', timeout: 60000 });

  console.log('  [1] Pilih instansi...');
  await page.locator('select').filter({ hasText: INSTANSI.substring(0, 20) }).selectOption(INSTANSI);
  await page.waitForTimeout(1500);

  const nips = nipList || DAFTAR_NIP;
  const totalAll = DAFTAR_NIP.length;
  console.log(`  Total NIP: ${nips.length}`);

  const failedNips = [];

  for (let i = 0; i < nips.length; i++) {
    const nip = nips[i];
    const seq = nipList ? `${DAFTAR_NIP.indexOf(nip) + 1}/${totalAll}` : `${i+1}/${totalAll}`;
    console.log(`\n  --- Pegawai ${seq}: ${nip} ---`);

    try {
      // Reload halaman untuk state bersih
      await page.goto(HALAMAN_PEGAWAI, { waitUntil: 'load', timeout: 30000 });
      await page.locator('select').filter({ hasText: INSTANSI.substring(0, 20) }).selectOption(INSTANSI);
      await page.waitForTimeout(800);

      const input = page.locator('#pegawai_autocomplete');
      await input.fill(nip);
      await page.waitForTimeout(1000);

      // Pilih autocomplete
      await input.focus();
      await page.waitForTimeout(200);
      await input.press('ArrowDown');
      await page.waitForTimeout(300);
      await input.press('Enter');
      await page.waitForTimeout(1000);

      const selected = await input.inputValue();
      console.log(`      ✓ ${selected}`);

      console.log('  [2] Klik Update...');

      // Klik Update & tangkap tab baru
      const [newPage] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 15000 }).catch(() => null),
        page.evaluate(() => document.querySelector('#btnGenerate')?.click())
      ]);

      if (newPage) {
        try {
          await newPage.waitForLoadState();
          await newPage.close();
        } catch { /* ok */ }
        console.log('      ✓ Tab baru ditutup.');
      } else {
        await page.waitForTimeout(3000);
      }
    } catch (err) {
      const errMsg = err.message.split('\n')[0];
      console.log(`      ⚠️  Gagal: ${errMsg}`);
      console.log('      ➜ Skip');
      failedNips.push(nip);

      // Recovery: kalo page/context closed, bikin baru dari browser & login ulang
      if (errMsg.includes('closed') || errMsg.includes('Timeout')) {
        try {
          await browser.close();
        } catch { /* ok */ }
        browser = await chromium.launch({
          headless: HEADLESS !== undefined ? HEADLESS : true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        });
        page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

        // Login ulang karena browser baru
        const login = require('./login');
        await login.run(page);
        await page.goto(HALAMAN_PEGAWAI, { waitUntil: 'load', timeout: 30000 });
        await page.locator('select').filter({ hasText: INSTANSI.substring(0, 20) }).selectOption(INSTANSI);
        console.log('      ↻ Browser baru + login ulang.');
      } else {
        // Coba navigasi balik
        try { await page.goto(HALAMAN_PEGAWAI, { timeout: 30000 }); } catch { /* ok */ }
      }
    }
  }

  return failedNips;
}

// ===== Standalone =====
if (require.main === module) {
  loginThenRun(async (page) => {
    const browser = page.context().browser();
    await run(page, browser);
  }, 'Update Pegawai');
}

module.exports = { run, nama: 'Update Pegawai' };
