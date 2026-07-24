/**
 * Update 38 pegawai yang gagal di cron pagi 23 Juli
 * 
 * Run: node tasks/update-failed-38.js
 */
const path = require('path');
const { chromium } = require('playwright');
const config = require('../config');
const login = require('./login');
const updatePegawai = require('./update-pegawai');

// 38 NIP yang gagal di cron pagi (pegawai #29-#66)
const FAILED_NIPS = [
  '197005141997031005', // 29
  '197805212010012001', // 30
  '198903152014022001', // 31
  '197212082009011001', // 32
  '197209201992021003', // 33
  '197207082008011011', // 34
  '199803172022082001', // 35
  '198203192024211004', // 36
  '198008142025211015', // 37
  '199711242024212019', // 38
  '199002242024211006', // 39
  '199705112024212033', // 40
  '199309222024212015', // 41
  '199104202025211004', // 42
  '199009042025211019', // 43
  '198509022025212004', // 44
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
  console.log('  UPDATE 38 PEGAWAI GAGAL');
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
    console.log('\n✅✅ Update 38 pegawai selesai! ✅✅');
  } catch (err) {
    console.error('\n❌ Fatal error:', err.message);
  } finally {
    await browser.close();
  }

  process.exit(0);
})();
