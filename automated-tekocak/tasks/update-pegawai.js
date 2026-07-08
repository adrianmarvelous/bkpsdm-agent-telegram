/**
 * Task 3: Update Data Pegawai
 *
 * Standalone (login otomatis): node tasks/update-pegawai.js
 * Terintegrasi (sudah login):  panggil updatePegawai.run(page, browser)
 */

const { chromium } = require('playwright');
const { loginThenRun } = require('./_helper');
const { HALAMAN_PEGAWAI, INSTANSI, DAFTAR_NIP } = require('../config');

async function run(page, browser, nipList = null) {
  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('  TASK 3: UPDATE DATA PEGAWAI');
  console.log('═══════════════════════════════════════');

  await page.goto(HALAMAN_PEGAWAI, { waitUntil: 'networkidle' });

  console.log('  [1] Pilih instansi...');
  await page.locator('select').filter({ hasText: INSTANSI.substring(0, 20) }).selectOption(INSTANSI);
  await page.waitForTimeout(1500);

  const nips = nipList || DAFTAR_NIP;
  console.log(`  Total NIP: ${nips.length}`);

  for (let i = 0; i < nips.length; i++) {
    const nip = nips[i];
    console.log(`\n  --- Pegawai ${i+1}/${DAFTAR_NIP.length}: ${nip} ---`);

    try {
      // Reload halaman untuk state bersih
      await page.goto(HALAMAN_PEGAWAI, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await page.locator('select').filter({ hasText: INSTANSI.substring(0, 20) }).selectOption(INSTANSI);
      await page.waitForTimeout(1500);

      const input = page.locator('#pegawai_autocomplete');
      await input.fill(nip);
      await page.waitForTimeout(2000);

      // Pilih autocomplete
      await input.focus();
      await page.waitForTimeout(300);
      await input.press('ArrowDown');
      await page.waitForTimeout(500);
      await input.press('Enter');
      await page.waitForTimeout(2000);

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
        // Cek apakah halaman sudah pindah
        await page.waitForTimeout(3000);
        // Kembalikan ke halaman pegawai
        await page.goto(HALAMAN_PEGAWAI, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      }
    } catch (err) {
      const errMsg = err.message.split('\n')[0];
      console.log(`      ⚠️  Gagal: ${errMsg}`);
      console.log('      ➜ Skip');

      // Jika page sudah closed, buat page baru dari browser
      if (errMsg.includes('closed')) {
        try {
          page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
          await page.goto(HALAMAN_PEGAWAI, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
          await page.locator('select').filter({ hasText: INSTANSI.substring(0, 20) }).selectOption(INSTANSI);
          await page.waitForTimeout(1500);
          console.log('      ↻ Page baru dibuat & login ulang.');
        } catch { /* ok */ }
      } else {
        // Pull page back
        try { await page.goto(HALAMAN_PEGAWAI, { timeout: 30000 }).catch(() => {}); } catch { /* ok */ }
      }
    }
  }
}

// ===== Standalone =====
if (require.main === module) {
  loginThenRun(async (page) => {
    const browser = page.context().browser();
    await run(page, browser);
  }, 'Update Pegawai');
}

module.exports = { run, nama: 'Update Pegawai' };
