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

  let last = '';
  while (true) {
    const hasDlg = await page.evaluate(() => document.querySelector('dialog[open]') !== null);
    if (!hasDlg) break;
    const txt = await page.evaluate(() => { const d = document.querySelector('dialog[open]'); return d ? d.textContent||'' : ''; });
    const m = txt.match(/Proses ke : (\d+) dari total (\d+)/);
    if (m) {
      const pct = Math.round((parseInt(m[1])/parseInt(m[2]))*100);
      const p = `${m[1]}/${m[2]} (${pct}%)`;
      if (p !== last) { console.log(`     Progress: ${p}`); last = p; }
    }
    await page.waitForTimeout(5000);
  }
  console.log('  ✓ Generate selesai!');

  try {
    const ok = page.locator('button:has-text("Ok"), button:has-text("OK")').first();
    await ok.waitFor({ state: 'visible', timeout: 5000 });
    await ok.click();
  } catch { /* ok */ }
}

// ===== Standalone =====
if (require.main === module) {
  loginThenRun(run, 'Generate Laporan');
}

module.exports = { run, nama: 'Generate Laporan' };
