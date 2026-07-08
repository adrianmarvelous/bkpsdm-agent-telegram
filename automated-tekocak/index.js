/**
 * TEKO-CAK Automasi — MAIN
 *
 * Menjalankan SEMUA task berurutan (login sekali):
 *   node index.js
 *
 * Atau jalan per-task:
 *   node tasks/login.js
 *   node tasks/generate.js
 *   node tasks/update-pegawai.js
 */

const { chromium } = require('playwright');
const config = require('./config');
const login = require('./tasks/login');
const generate = require('./tasks/generate');
const updatePegawai = require('./tasks/update-pegawai');

(async () => {
  const browser = await chromium.launch({ headless: config.HEADLESS });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  try {
    // Login sekali, dipakai untuk semua task
    await login.run(page);
    await generate.run(page);
    await updatePegawai.run(page, browser);

    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('  ✅ SEMUA TASK SELESAI!');
    console.log('═══════════════════════════════════════');

    await page.pause();
  } catch (error) {
    console.error('\n[✗] Error:', error.message);
    await browser.close();
  }
})();
