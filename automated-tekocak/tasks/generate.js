/**
 * Task 2: Generate Laporan
 *
 * Standalone (login otomatis): node tasks/generate.js
 * Terintegrasi (sudah login):  panggil generate.run(page)
 */

const { chromium } = require('playwright');
const { loginThenRun } = require('./_helper');
const { HALAMAN_GENERATE } = require('../config');

async function run(page) {
  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('  TASK 2: GENERATE LAPORAN');
  console.log('═══════════════════════════════════════');

  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const year = now.getFullYear();
  const tglMulai = `01/${month}/${year}`;
  const tglAkhir = `${day}/${month}/${year}`;

  await page.goto(HALAMAN_GENERATE, { waitUntil: 'networkidle' });

  console.log('  [1] Pilih "By : Instansi"...');
  await page.locator('select').nth(1).selectOption('By : Instansi');
  await page.waitForTimeout(1500);

  console.log(`  [2] Isi tanggal: ${tglMulai} - ${tglAkhir}`);
  await page.evaluate(v => { const e = document.querySelector('#tgl_mulai'); if(e){e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}));} }, tglMulai);
  await page.evaluate(v => { const e = document.querySelector('#tgl_akhir'); if(e){e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}));} }, tglAkhir);
  await page.waitForTimeout(500);

  console.log('  [3] Klik Generate & tunggu...');
  await page.locator('#modal_generate_instansi button:has-text("Generate")').click();

  // ===== PANTAU PROGRESS (Bootstrap modal #pesan_modal) =====
  try {
    // Tunggu modal progress sebentar
    await page.waitForSelector('#pesan_modal.in, #pesan_modal.show', { timeout: 8000 });
    console.log('     [Modal progress muncul]');

    let lastPct = -1;
    while (true) {
      const modalVisible = await page.evaluate(() => {
        try {
          const m = document.querySelector('#pesan_modal');
          return m && (m.classList.contains('in') || m.classList.contains('show') || m.style.display === 'block');
        } catch { return false; }
      }).catch(() => false);
      if (!modalVisible) {
        console.log('     [Modal progress tertutup]');
        break;
      }

      const txt = await page.evaluate(() => {
        try {
          const s = document.querySelector('#proses-data');
          return s ? s.textContent || '' : '';
        } catch { return ''; }
      }).catch(() => '');

      const m = txt.match(/Proses ke : (\d+) dari total (\d+)/);
      if (m) {
        const pct = Math.round((parseInt(m[1])/parseInt(m[2]))*100);
        if (pct !== lastPct) {
          const bar = '█'.repeat(Math.round(pct/5)) + '░'.repeat(Math.round((100-pct)/5));
          console.log(`     ${bar} ${m[1]}/${m[2]} (${pct}%)`);
          lastPct = pct;
        }
        if (pct >= 100) {
          console.log('  ✅ Generate 100% selesai!');
          break;
        }
      }
      try { await page.waitForTimeout(2000); } catch { break; }
    }
  } catch (err) {
    // Page mungkin ter-refresh setelah generate selesai — itu normal
    console.log(`     [${err.message.split('\n')[0]}]`);
  }

  console.log('  ✅ Generate selesai!');
}

// ===== Standalone =====
if (require.main === module) {
  loginThenRun(run, 'Generate Laporan');
}

module.exports = { run, nama: 'Generate Laporan' };
