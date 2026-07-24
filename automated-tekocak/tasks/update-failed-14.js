/**
 * Update 14 pegawai yang gagal di cron sore
 * 
 * Run: node tasks/update-failed-14.js
 */
const path = require('path');
const { chromium } = require('playwright');
const config = require('../config');
const login = require('./login');
const updatePegawai = require('./update-pegawai');

// 16 NIP yang gagal di cron pagi (NIP 51-66)
const FAILED_NIPS = [
  '199405312025212064',
  '198409222025211050',
  '199703062025212049',
  '199601292025211049',
  '198103242025211047',
  '200405112025211001',
  '197802222025211039',
  '198101052025211077',
  '198010312025212019',
  '3578192805950003',
  '3578172105950006',
  '3578041306950011',
  '3578016205030003',
  '3525141005830001',
  '3526152612010001',
  '3506041009770002',
];

(async () => {
  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('  UPDATE 16 PEGAWAI GAGAL');
  console.log('═══════════════════════════════════════');
  console.log(`  Total: ${FAILED_NIPS.length} pegawai`);
  console.log(`  Mode: ${config.HEADLESS ? 'Headless' : 'Visible'}`);
  console.log(`  URL: ${config.TEKOCAK_URL}`);
  console.log('');

  const browser = await chromium.launch({
    headless: config.HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  try {
    console.log('🔐 Login TEKO-CAK...');
    await login.run(page);
    console.log('✅ Login berhasil!\n');

    await updatePegawai.run(page, browser, FAILED_NIPS);
    console.log('\n✅ ✅ Update 14 pegawai selesai! ✅');
  } catch (err) {
    console.error('\n❌ Fatal error:', err.message);
  } finally {
    await browser.close();
  }

  process.exit(0);
})();
