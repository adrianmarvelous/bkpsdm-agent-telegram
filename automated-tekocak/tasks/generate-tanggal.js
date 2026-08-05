/**
 * Task: Generate Laporan untuk Tanggal Spesifik
 *
 * Perintah baru (dari Telegram): /tekocak generate tanggal <tanggal>
 * — tgl_mulai DAN tgl_akhir diisi tanggal yang sama (generate 1 hari).
 *
 * Sengaja TERPISAH dari tasks/generate.js (yang selalu H-1 → hari ini)
 * agar perintah awal "generate" tidak berubah sama sekali.
 *
 * Standalone (login otomatis):
 *   node tasks/generate-tanggal.js YYYY-MM-DD
 * Terintegrasi (sudah login):
 *   generateTanggal.run(page, 'YYYY-MM-DD')
 */

const { chromium } = require('playwright');
const { loginThenRun } = require('./_helper');
const { HALAMAN_GENERATE } = require('../config');

/**
 * Format "YYYY-MM-DD" → "DD/MM/YYYY" untuk form TEKO-CAK.
 * Validasi tanggal real juga (mis. 2026-02-31 → null).
 *
 * @param {string} tanggal Format YYYY-MM-DD
 * @returns {string|null} DD/MM/YYYY atau null kalau tidak valid
 */
function formatTglKeForm(tanggal) {
  if (!tanggal) return null;
  const m = String(tanggal).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  const valid =
    dt.getFullYear() === Number(y) &&
    dt.getMonth() === Number(mo) - 1 &&
    dt.getDate() === Number(d);
  if (!valid) return null;
  return `${d.padStart(2, '0')}/${mo.padStart(2, '0')}/${y}`;
}

async function run(page, tanggal) {
  const tglForm = formatTglKeForm(tanggal);
  if (!tglForm) {
    throw new Error(`Tanggal tidak valid: ${tanggal} (format: YYYY-MM-DD)`);
  }

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('  TASK: GENERATE LAPORAN (TANGGAL SPESIFIK)');
  console.log('═══════════════════════════════════════');
  console.log(`  📅 Tanggal: ${tglForm} (mulai = akhir)`);

  await page.goto(HALAMAN_GENERATE, { waitUntil: 'load', timeout: 60000 });

  console.log('  [1] Pilih "By : Instansi"...');
  await page.locator('select').nth(1).selectOption('By : Instansi');
  await page.waitForTimeout(1500);

  console.log(`  [2] Isi tanggal: ${tglForm} - ${tglForm}`);
  await page.evaluate(v => { const e = document.querySelector('#tgl_mulai'); if(e){e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}));} }, tglForm);
  await page.evaluate(v => { const e = document.querySelector('#tgl_akhir'); if(e){e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}));} }, tglForm);
  await page.waitForTimeout(500);

  console.log('  [3] Klik Generate & tunggu...');
  await page.locator('#modal_generate_instansi button:has-text("Generate")').click();

  // ===== PANTAU PROGRESS (Bootstrap modal #pesan_modal) =====
  // NOTE: lastPct/totalData dideklarasikan DI LUAR try — di generate.js asli
  // mereka di dalam try, sehingga catch block bisa kena ReferenceError.
  let lastPct = -1;
  let totalData = 0;
  try {
    // Tunggu modal progress sebentar
    await page.waitForSelector('#pesan_modal.in, #pesan_modal.show', { timeout: 8000 });
    console.log('     [Modal progress muncul]');

    // Baca progress pertama KALI (0%) langsung
    const firstTxt = await page.evaluate(() => {
      try { const s = document.querySelector('#proses-data'); return s ? s.textContent || '' : ''; }
      catch { return ''; }
    }).catch(() => '');
    const firstM = firstTxt.match(/Proses ke : (\d+) dari total (\d+)/);
    if (firstM) {
      totalData = parseInt(firstM[2]);
      const pct = Math.round((parseInt(firstM[1])/parseInt(firstM[2]))*100);
      const nextMilestone = Math.ceil(pct / 10) * 10; // Cetak tiap 10%
      if (pct !== lastPct) {
        console.log(`     🔄 ${firstM[1]}/${firstM[2]} (${pct}%)`);
        lastPct = pct;
      }
    }

    while (true) {
      const modalVisible = await page.evaluate(() => {
        try {
          const m = document.querySelector('#pesan_modal');
          return m && (m.classList.contains('in') || m.classList.contains('show') || m.style.display === 'block');
        } catch { return false; }
      }).catch(() => false);
      if (!modalVisible) {
        // Tampilkan progress terakhir sebelum modal nutup
        if (lastPct >= 0 && lastPct < 100) {
          console.log(`     ⏹️ Berhenti di ${lastPct}% (modal ditutup)`);
        }
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
        totalData = parseInt(m[2]);
        const pct = Math.round((parseInt(m[1])/parseInt(m[2]))*100);
        const milestone = Math.floor(pct / 10) * 10;
        const lastMilestone = Math.floor(lastPct / 10) * 10;
        // Cetak setiap 10% atau ketika berubah
        if (pct !== lastPct && (milestone > lastMilestone || pct === 100)) {
          console.log(`     🔄 ${m[1]}/${m[2]} (${pct}%)`);
          lastPct = pct;
        }
        if (pct >= 100) {
          console.log('  ✅ Generate 100% selesai!');
          break;
        }
      }
      try { await page.waitForTimeout(1000); } catch { break; } // Cek tiap 1 detik
    }
  } catch (err) {
    // Page mungkin ter-refresh setelah generate selesai — itu normal
    const msg = err.message ? err.message.split('\n')[0] : 'error';
    if (lastPct >= 0) {
      console.log(`     ⏹️ Selesai di ${lastPct}%`);
    }
    console.log(`     [${msg}]`);
  }

  console.log('  ✅ Generate selesai!');
}

// ===== Standalone =====
if (require.main === module) {
  const tanggal = process.argv[2];
  if (!tanggal || !formatTglKeForm(tanggal)) {
    console.error('❌ Usage: node tasks/generate-tanggal.js YYYY-MM-DD');
    console.error('   Contoh: node tasks/generate-tanggal.js 2026-08-04');
    process.exit(1);
  }
  loginThenRun((page) => run(page, tanggal), `Generate Laporan (${tanggal})`);
}

module.exports = { run, nama: 'Generate Laporan Tanggal Spesifik', formatTglKeForm };
