/**
 * Update 22 pegawai yang gagal di cron pagi
 * 
 * Run: node tasks/update-failed-22.js
 */
const path = require('path');
const { chromium } = require('playwright');
const config = require('../config');
const login = require('./login');
const updatePegawai = require('./update-pegawai');

const FAILED_NIPS = [
  '199005312024211015', // 45
  '198001082025212003', // 46
  '199306032025211132', // 47
  '199910282025211031', // 48
  '198302122025211110', // 49
  '199611262025211036', // 50
  '199405312025212064', // 51
  '198409222025211050', // 52
  '199703062025212049', // 53
  '199601292025211049', // 54
  '198103242025211047', // 55
  '200405112025211001', // 56
  '197802222025211039', // 57
  '198101052025211077', // 58
  '198010312025212019', // 59
  '3578192805950003',   // 60
  '3578172105950006',   // 61
  '3578041306950011',   // 62
  '3578016205030003',   // 63
  '3525141005830001',   // 64
  '3526152612010001',   // 65
  '3506041009770002',   // 66
];

(async () => {
  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('  UPDATE 22 PEGAWAI GAGAL');
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
    console.log('\n✅✅ Update 22 pegawai selesai! ✅✅');
  } catch (err) {
    console.error('\n❌ Fatal error:', err.message);
  } finally {
    await browser.close();
  }

  process.exit(0);
})();
